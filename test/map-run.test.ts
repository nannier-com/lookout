// `lookout map` end to end through the mock CLI: the reply lands as a file,
// a fresh map spends nothing, an edited router re-scans, the walk's record
// survives a re-scan, and `check`'s consent rules decide when a scan is
// spent on its behalf.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureMap } from "../src/map/ensure.js";
import { runMap } from "../src/map/run.js";
import { loadMap, nodeByScreen, updateMap } from "../src/map/store.js";
import { readIncidents } from "../src/skills/incidents.js";
import type { ResolvedConfig } from "../src/types.js";
import { tmpProject } from "./tmp-project.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");
const silent = (): void => {};

function project(prefix: string): ResolvedConfig {
  const r = tmpProject(prefix);
  const src = join(r.projectDir, "src");
  mkdirSync(join(src, "app"), { recursive: true });
  writeFileSync(
    join(src, "router.tsx"),
    "import { createBrowserRouter } from 'react-router-dom';\nexport const AppRouter = createBrowserRouter([{ path: '/' }]);\n",
  );
  writeFileSync(join(src, "app", "page.tsx"), "export function HomePage() { return <a href=\"/discovered\">Discovered</a>; }\n");
  return r;
}

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_ARGV_FILE;
  delete process.env.MOCK_MAP;
});

describe("runMap", () => {
  test("writes the map from the reply, dropping what the parser refuses and recording the fabrication", async () => {
    const r = project("lookout-map-run-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const argv = join(r.projectDir, "argv.jsonl");
    process.env.MOCK_ARGV_FILE = argv;
    const result = await runMap(r, { log: silent });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({ name: "app", status: "scanned", routes: 2, states: 1 });
    expect(result.costUsd).toBeGreaterThan(0);

    const map = (await loadMap(r))!;
    const root = map.targets.app!.roots[0]!;
    expect(root.path).toBe("/");
    expect(root.children.map((c) => c.id)).toEqual(["menu-open", "/discovered"]);
    expect(nodeByScreen(map, "app", "/", "menu-open")?.open?.affordance).toEqual({ role: "button", name: "Menu" });
    // The citation's line came from the file, not the reply.
    expect(root.children[0]!.source).toMatchObject({ path: join(r.projectDir, "src", "router.tsx"), symbol: "AppRouter", line: 2 });
    expect(map.targets.app!.notes.some((n) => /"Bad Name"/.test(n))).toBe(true);
    expect(map.targets.app!.notes.some((n) => /never\.tsx is outside the repository/.test(n))).toBe(true);
    expect(map.targets.app!.examined.map((e) => e.path).sort()).toEqual(["src/app/page.tsx", "src/router.tsx"]);
    expect(map.targets.app!.skipped).toEqual([{ what: "/users/:id", reason: "parametrised path" }]);

    // The prompt carried the candidate paths and never their contents, and
    // the reader ran with the repository as its working directory.
    const prompt = (JSON.parse(readFileSync(argv, "utf8").split("\n")[0]!) as string[]);
    const text = prompt[prompt.indexOf("-p") + 1]!;
    expect(text).toContain(join(r.projectDir, "src", "router.tsx"));
    expect(text).not.toContain("createBrowserRouter([");
    expect(text).toContain('Target "app" at http://localhost:1');
    expect(prompt).toContain("--allowedTools");
    expect(prompt[prompt.indexOf("--allowedTools") + 1]).toContain("Grep");

    // A fabricated citation is the one drop that is an incident.
    const incidents = readIncidents(r.projectDir);
    expect(incidents.some((i) => i.kind === "judge-rejected" && i.verb === "map")).toBe(true);
  });

  test("a fresh map spends nothing; an edited router re-scans; --refresh re-scans a fresh one", async () => {
    const r = project("lookout-map-fresh-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const argv = join(r.projectDir, "argv.jsonl");
    process.env.MOCK_ARGV_FILE = argv;
    await runMap(r, { log: silent });
    const again = await runMap(r, { log: silent });
    expect(again.targets[0]).toMatchObject({ status: "fresh", costUsd: 0 });
    expect(readFileSync(argv, "utf8").trim().split("\n")).toHaveLength(1);

    writeFileSync(join(r.projectDir, "src", "router.tsx"), "export const AppRouter = createBrowserRouter([{ path: '/' }, { path: '/new' }]);\n");
    const rescanned = await runMap(r, { log: silent });
    expect(rescanned.targets[0]).toMatchObject({ status: "scanned" });
    expect(rescanned.targets[0]!.reasons).toEqual(["1 examined file(s) changed"]);

    const forced = await runMap(r, { refresh: true, log: silent });
    expect(forced.targets[0]).toMatchObject({ status: "scanned", reasons: ["--refresh"] });
    expect(readFileSync(argv, "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("what the walk learned survives a re-scan of the same screens", async () => {
    const r = project("lookout-map-carry-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    await runMap(r, { log: silent });
    await updateMap(r, (f) => {
      nodeByScreen(f, "app", "/", "menu-open")!.walk = { reached: true, verifiedAt: "then" };
    });
    await runMap(r, { refresh: true, log: silent });
    expect(nodeByScreen((await loadMap(r))!, "app", "/", "menu-open")?.walk).toEqual({ reached: true, verifiedAt: "then" });
  });

  test("an unusable reply keeps the previous map and writes an incident", async () => {
    const r = project("lookout-map-junk-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    await runMap(r, { log: silent });
    process.env.MOCK_MAP = "not json at all";
    const result = await runMap(r, { refresh: true, log: silent });
    expect(result.targets[0]).toMatchObject({ name: "app", status: "failed", routes: 2 });
    expect((await loadMap(r))!.targets.app!.roots).toHaveLength(1);
    expect(readIncidents(r.projectDir).some((i) => i.kind === "judge-unparseable" && i.verb === "map")).toBe(true);
  });

  test("an unknown target and an AI with no model are refused before anything is spent", async () => {
    const r = project("lookout-map-refuse-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    await expect(runMap(r, { targets: ["nope"], log: silent })).rejects.toThrow(/unknown target "nope"/);
    await expect(runMap(r, { ai: "codex", log: silent })).rejects.toThrow(/names no model/);
    await expect(runMap(r, { ai: "gemini", log: silent })).rejects.toThrow(/no AI adapter/);
    expect(await loadMap(r)).toBeNull();
  });
});

describe("ensureMap", () => {
  test("no map and no consent is the matrix; --map spends the scan; --no-map is the matrix whatever exists", async () => {
    const r = project("lookout-map-ensure-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const lines: string[] = [];
    const log = (l: string): void => {
      lines.push(l);
    };
    expect((await ensureMap(r, {}, { log })).map).toBeNull();
    expect(lines.some((l) => /no screen map; capturing the matrix/.test(l))).toBe(true);

    const consented = await ensureMap(r, { map: true }, { log });
    expect(consented.refreshed).toEqual(["app"]);
    expect(consented.map?.targets.app?.roots).toHaveLength(1);
    expect(consented.costUsd).toBeGreaterThan(0);

    expect((await ensureMap(r, { "no-map": true }, { log })).map).toBeNull();
  });

  test("a stale map is walked with a warning unless the project or the run consented to a refresh", async () => {
    const r = project("lookout-map-stale-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    await runMap(r, { log: silent });
    writeFileSync(join(r.projectDir, "src", "router.tsx"), "export const AppRouter = createBrowserRouter([{ path: '/' }, { path: '/more' }]);\n");

    const lines: string[] = [];
    const walked = await ensureMap(r, {}, { log: (l) => lines.push(l) });
    expect(walked.map).not.toBeNull();
    expect(walked.stale).toEqual([{ target: "app", reasons: ["1 examined file(s) changed"] }]);
    expect(walked.refreshed).toEqual([]);
    expect(lines.some((l) => /stale.*walking it anyway/.test(l))).toBe(true);

    const project2: ResolvedConfig = { ...r, config: { ...r.config, map: { enabled: true } } };
    const refreshed = await ensureMap(project2, {}, { log: silent });
    expect(refreshed.refreshed).toEqual(["app"]);
    expect(refreshed.stale).toEqual([]);

    const off: ResolvedConfig = { ...r, config: { ...r.config, map: { enabled: false } } };
    expect((await ensureMap(off, {}, { log: silent })).map).toBeNull();
  });
});
