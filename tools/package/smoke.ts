#!/usr/bin/env bun
/**
 * Install the exact npm tarball in isolation and exercise what users receive.
 *
 * Unit tests run from source, so they cannot catch a missing package file, a
 * broken bin link, or a UI asset that the build forgot to copy. This packs the
 * repository, installs only that tarball, starts its public `lookout` command,
 * and opens the installed UI in Chromium against the complete UI fixture.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright";
import { buildFixture } from "../ui-check/fixture.js";

const ROOT = join(import.meta.dir, "..", "..");

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HUSKY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForUi(child: ChildProcess, url: string): Promise<Response> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (terminated(child)) {
      throw new Error(`installed lookout ui terminated ${child.exitCode ?? child.signalCode} before it became ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The installed server is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`installed lookout ui did not answer ${url} within 15 seconds`);
}

function terminated(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (terminated(child)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
    if (terminated(child)) done(true);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (terminated(child)) return;
  child.kill("SIGINT");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 5_000))) throw new Error("installed lookout ui did not exit after SIGKILL");
}

const work = realpathSync(mkdtempSync(join(tmpdir(), "lookout-package-smoke-")));
let child: ChildProcess | null = null;
try {
  const packed = JSON.parse(run(ROOT, "npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    work,
    "--cache",
    join(work, "npm-cache"),
  ])) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const result = packed[0];
  if (!result) throw new Error("npm pack returned no package");
  const tarball = join(work, basename(result.filename));
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);

  const files = new Set(result.files.map((file) => file.path));
  for (const required of ["dist/cli.js", "dist/index.js", "dist/index.d.ts", "dist/ui/client/shell.html"]) {
    if (!files.has(required)) throw new Error(`packed package is missing ${required}`);
  }
  if (![...files].some((file) => file === "dist/ui/client/main.js")) {
    throw new Error("packed package is missing the UI entry module");
  }

  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "lookout-packed-consumer",
    private: true,
    version: "1.0.0",
    dependencies: { "@nannier-com/lookout": `file:${tarball}` },
  }, null, 2));
  run(consumer, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);

  const cli = join(consumer, "node_modules", ".bin", "lookout");
  if (!existsSync(cli)) throw new Error("installed package did not create node_modules/.bin/lookout");
  const protocol = run(consumer, cli, ["protocol"]);
  if (!protocol.includes("lookout") || !protocol.includes("capture")) {
    throw new Error("installed lookout command did not print its protocol");
  }

  const fixture = await buildFixture(join(work, "fixture"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  child = spawn(cli, ["ui", "--port", String(port)], {
    cwd: fixture.project,
    env: {
      ...process.env,
      LOOKOUT_CHECKOUT: fixture.checkout,
      LOOKOUT_NO_HANDOFF: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pageResponse = await waitForUi(child, url);
  const html = await pageResponse.text();
  const assets = [...new Set([...html.matchAll(/(?:href|src)="(\/ui\/[^"]+)"/g)].map((match) => match[1]!))];
  if (!assets.length) throw new Error("installed UI page links no assets");
  for (const asset of assets) {
    const response = await fetch(new URL(asset, url));
    if (!response.ok) throw new Error(`installed UI asset ${asset} returned ${response.status}`);
    if (!(await response.arrayBuffer()).byteLength) throw new Error(`installed UI asset ${asset} is empty`);
  }
  const status = await fetch(new URL("/api/status", url));
  if (!status.ok || !(await status.text()).includes("\"board\"")) {
    throw new Error(`installed UI status endpoint returned ${status.status} without a board`);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("article.card").first().waitFor({ state: "visible" });
    if ((await page.locator("article.card").count()) < 1) throw new Error("installed UI rendered no issue cards");
    if (problems.length) throw new Error(`installed UI browser errors:\n${problems.join("\n")}`);
  } finally {
    await browser.close();
  }

  console.log(`package smoke: ${basename(tarball)} installed, its bin ran, ${assets.length} UI assets loaded, and Chromium rendered the board`);
} finally {
  try {
    if (child) await stop(child);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
