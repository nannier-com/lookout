#!/usr/bin/env bun
/**
 * The gate for anything `lookout ui` renders.
 *
 * Type checks and tests say nothing about what a browser draws. Three real bugs
 * in this repo passed every other gate and were caught here: a filter bar with
 * no `[hidden]` rule that could not be hidden, and two optional fields
 * dereferenced after being guarded on a copy.
 *
 * Four commands, meant to bracket a change: `fixture` builds a throwaway
 * project with something in every part of the page, `serve` points the ui at
 * it, `shots` captures a fixed set of views, `diff` compares two captures pixel
 * by pixel, and `drive` clicks through the page and asserts what should happen.
 *
 * See README.md beside this file for the order to run them in.
 */
import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { buildFixture } from "./fixture.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORK = join(ROOT, ".lookout-ui-check");
const PORT = Number(process.env.UI_CHECK_PORT ?? 7399);
const URL = `http://127.0.0.1:${PORT}/`;

function fixturePaths(): { project: string; home: string; checkout: string } {
  return {
    project: join(WORK, "fixture", "project"),
    home: join(WORK, "fixture", "home"),
    checkout: join(WORK, "fixture", "checkout"),
  };
}

/** Capture one view, after letting the page settle. */
async function view(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  out: string,
  name: string,
  scheme: "dark" | "light",
  width: number,
  height: number,
  act: (p: Page) => Promise<void>,
  problems: string[],
): Promise<void> {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width, height } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${name}: ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${name}: console ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await act(page);
  // Settle: a filter tile smooth-scrolls and flashes for over a second, and a
  // focus ring on whatever was clicked differs between runs rather than between
  // revisions. Both are noise this gate must not report.
  await page.waitForTimeout(1600);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  await ctx.close();
}

async function shots(label: string): Promise<void> {
  const out = join(WORK, "shots", label);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const problems: string[] = [];
  const nothing = async (): Promise<void> => {};
  await view(browser, out, "board-dark", "dark", 1440, 950, nothing, problems);
  await view(browser, out, "board-light", "light", 1440, 950, nothing, problems);
  await view(browser, out, "board-narrow", "light", 430, 900, nothing, problems);
  await view(browser, out, "board-filtered", "dark", 1440, 950, (p) => p.click('button.stat[data-value="archived"]'), problems);
  // The settled issue, which is the only card carrying both halves of a pre and
  // post fix pair. It is filtered off the default board, so without this view
  // the comparison the page exists to show is never captured.
  await view(browser, out, "board-done", "dark", 1440, 950, (p) => p.click('button.stat[data-value="done"]'), problems);
  await view(browser, out, "settings-open", "dark", 1440, 950, (p) => p.click("#cog"), problems);
  await view(browser, out, "learning-dark", "dark", 1440, 950, (p) => p.click('[data-view="learning"]'), problems);
  await view(browser, out, "learning-light", "light", 1440, 950, (p) => p.click('[data-view="learning"]'), problems);
  await view(browser, out, "learning-narrow", "dark", 430, 900, (p) => p.click('[data-view="learning"]'), problems);
  await browser.close();
  console.log(`${label}: ${readdirSync(out).filter((n) => n.endsWith(".png")).length} views in ${out}`);
  console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "no page or console errors");
}

/**
 * Compare two captures, and crop what differs.
 *
 * A refactor should come out identical, or differing only in the relative
 * "seen" clock the fixture carries. The crop beside a differing view is how you
 * tell those apart without guessing.
 */
async function diff(a: string, b: string): Promise<number> {
  const dirA = join(WORK, "shots", a);
  const dirB = join(WORK, "shots", b);
  let worst = 0;
  for (const f of readdirSync(dirA).filter((n) => n.endsWith(".png"))) {
    const [x, y] = await Promise.all([
      sharp(join(dirA, f)).raw().toBuffer({ resolveWithObject: true }),
      sharp(join(dirB, f)).raw().toBuffer({ resolveWithObject: true }).catch(() => null),
    ]);
    if (!y) {
      console.log(`${f.padEnd(22)} MISSING in ${b}`);
      worst = 100;
      continue;
    }
    if (x.info.width !== y.info.width || x.info.height !== y.info.height) {
      console.log(`${f.padEnd(22)} SIZE ${x.info.width}x${x.info.height} -> ${y.info.width}x${y.info.height}`);
      worst = 100;
      continue;
    }
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    const { width, channels } = x.info;
    for (let i = 0; i < x.data.length; i += channels) {
      if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) {
        const px = (i / channels) % width;
        const py = Math.floor(i / channels / width);
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        n++;
      }
    }
    const pct = (n / (x.info.width * x.info.height)) * 100;
    worst = Math.max(worst, pct);
    if (n === 0) {
      console.log(`${f.padEnd(22)} identical`);
      continue;
    }
    const pad = 14;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const w = Math.min(x.info.width - left, maxX - minX + pad * 2);
    const h = Math.min(x.info.height - top, maxY - minY + pad * 2);
    const crop = join(WORK, "shots", `${b}-crop-${f}`);
    await sharp(join(dirB, f)).extract({ left, top, width: w, height: h }).resize({ width: Math.min(900, w * 3) }).png().toFile(crop);
    console.log(`${f.padEnd(22)} ${n} px differ (${pct.toFixed(3)}%)  ${crop}`);
  }
  console.log(worst === 0 ? "\nALL IDENTICAL" : `\nworst: ${worst.toFixed(3)}%`);
  return worst;
}

/** Click through the page and assert what each control is supposed to do. */
async function drive(): Promise<number> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "pass  " : "FAIL  "}${name}${detail ? `  ${detail}` : ""}`);
  };
  const shown = (): Promise<string[]> => page.locator("article.card .issueid").allTextContents();

  const before = await shown();
  check("board renders cards", before.length > 0, `ids=${before.join(",")}`);

  // The document link, on every card, followed rather than counted. A card
  // linking a 404 is indistinguishable from one linking a document until
  // somebody clicks it, and the URL is spelled in the client and matched in the
  // server, so the only check worth making is whether the file comes back.
  const docs = page.locator("article.card a.doc");
  const links = await docs.count();
  check("every card links its document", links === before.length, `${links} links for ${before.length} cards`);
  const href = links > 0 ? await docs.first().getAttribute("href") : null;
  const doc = href ? await page.request.get(URL + href.replace(/^\//, "")) : null;
  check("the document link resolves", doc?.status() === 200, `${href} -> ${doc?.status() ?? "not requested"}`);
  const text = doc ? await doc.text() : "";
  check("what comes back is that issue's document", text.includes(`issue:      ${before[0]}`), text.slice(0, 40));

  // The fixture has one issue in each of open, adjudicated and settled, and the
  // board shows one status at a time, so what a filter changes is which card is
  // on the board, not how many.
  await page.click('button.stat[data-value="archived"]');
  await page.waitForTimeout(1200);
  const during = await shown();
  check("filter changes which issues show", during.join() !== before.join(), `${before.join(",")} -> ${during.join(",")}`);
  check("filter bar appears", await page.locator("#filterbar").isVisible());
  // The intentional issue's folder was never written, so its card has nothing
  // to link. Offering a link there would be offering a 404.
  check("a card with no document on disk links none", (await docs.count()) === 0, `${await docs.count()} links`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  check("escape restores the board", (await shown()).join() === before.join());
  check("filter bar goes away", !(await page.locator("#filterbar").isVisible()));

  const buttons = page.locator("#toolToggle button");
  if ((await buttons.count()) > 1) {
    const second = buttons.nth(1);
    const key = await second.getAttribute("data-tool");
    await second.click();
    await page.waitForTimeout(1200);
    check("tool choice sticks", (await second.getAttribute("aria-pressed")) === "true", String(key));
    check("tool choice is remembered", (await page.evaluate(() => localStorage.getItem("lookout.tool"))) === key);
  } else {
    check("tool toggle has choices", false, `only ${await buttons.count()}`);
  }

  await page.click("#cog");
  await page.waitForTimeout(900);
  check("settings panel opens", await page.locator("#settings").isVisible());
  check("settings names the project", ((await page.locator("#setProject").textContent()) ?? "").includes("project"));
  check("settings probes targets", (await page.locator("#setTargets .tgt").count()) > 0);
  await page.click("#cog");

  await page.click('[data-view="learning"]');
  await page.waitForTimeout(1200);
  check("learning area shows", await page.locator("#learning").isVisible());
  check("issues area hides", !(await page.locator("#viewIssues").isVisible()));
  check("headline numbers hide with the board", !(await page.locator("#stats").isVisible()));
  check("learning history rendered", (await page.locator("#lhistory .lentry").count()) > 0);
  check("skills rendered", (await page.locator("#lskills .skill").count()) > 0);
  await page.click('[data-view="issues"]');
  await page.waitForTimeout(600);
  check("issues area comes back", await page.locator("#viewIssues").isVisible());

  console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno page or console errors");
  await browser.close();
  return failed + problems.length;
}

const [command, a, b] = process.argv.slice(2);

if (command === "fixture") {
  const paths = await buildFixture(join(WORK, "fixture"));
  console.log(`fixture built:\n  project  ${paths.project}\n  home     ${paths.home}\n  checkout ${paths.checkout}`);
} else if (command === "serve") {
  const { project, home, checkout } = fixturePaths();
  if (!existsSync(project)) {
    console.error("no fixture yet: run `bun tools/ui-check/run.ts fixture` first");
    process.exit(2);
  }
  // Inherit stdio so the ui's own startup lines are visible; this blocks.
  const child = spawn(process.execPath, [join(ROOT, "src", "cli.ts"), "ui", "--port", String(PORT)], {
    cwd: project,
    env: { ...process.env, LOOKOUT_HOME: home, LOOKOUT_CHECKOUT: checkout },
    stdio: "inherit",
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  await new Promise((done) => child.on("exit", done));
} else if (command === "shots") {
  await shots(a ?? "shots");
} else if (command === "diff") {
  if (!a || !b) {
    console.error("diff needs two labels, e.g. `diff before after`");
    process.exit(2);
  }
  process.exit((await diff(a, b)) === 0 ? 0 : 1);
} else if (command === "drive") {
  process.exit((await drive()) === 0 ? 0 : 1);
} else {
  console.log("usage: bun tools/ui-check/run.ts <fixture|serve|shots <label>|diff <a> <b>|drive>");
  process.exit(2);
}
