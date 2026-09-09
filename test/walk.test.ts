// The walk end to end, with the reach layer replaced by seams that write
// shots the way the tool server would, and the judges replaced by the mock
// CLI. What is pinned: one screen at a time in order, the ledger and the
// report written after every screen, the recording written back into the
// map, the --first stop rule, unreachable screens never cached as clean,
// the caps, and the events the page reads.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { evidenceDir } from "../src/config.js";
import { mergeRun } from "../src/capture/store.js";
import { walkMap } from "../src/check/walk.js";
import type { WalkPlan } from "../src/check/walk-gate.js";
import type { WalkOutcome } from "../src/check/walk-report.js";
import { loadLedger } from "../src/judge/ledger.js";
import { loadMap, nodeByScreen, saveMap, type MapFile, type MapNode } from "../src/map/store.js";
import type { ReachContext, ReachResult, Screen } from "../src/navigator/reach.js";
import { EventLog, readEvents, setCurrentLog } from "../src/report/events.js";
import { readIncidents } from "../src/skills/incidents.js";
import type { ResolvedConfig, ShotRecord } from "../src/types.js";
import { tmpProject } from "./tmp-project.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

let app: ReturnType<typeof Bun.serve>;
let base = "";
beforeAll(() => {
  app = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<h1>ok</h1>", { headers: { "content-type": "text/html" } }) });
  base = `http://127.0.0.1:${app.port}`;
});
afterAll(() => app.stop(true));
afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_ARGV_FILE;
  setCurrentLog(null);
});

function node(partial: Partial<MapNode> & Pick<MapNode, "id" | "kind">): MapNode {
  return {
    title: partial.id,
    open: null,
    risk: "safe",
    platforms: ["web"],
    source: { path: "/repo/src/App.tsx" },
    why: "",
    children: [],
    ...partial,
    ...(partial.kind === "route" && !partial.path ? { path: partial.id } : {}),
  };
}

function map(): MapFile {
  return {
    version: 1,
    project: "app",
    targets: {
      app: {
        url: base,
        mappedAt: "2026-09-09T00:00:00.000Z",
        skillVersion: 1,
        ai: "claude-code",
        model: "m",
        signature: "s",
        examined: [],
        roots: [
          node({ id: "/", kind: "route", title: "Home", children: [node({ id: "menu-open", kind: "state", title: "Menu", open: { affordance: { role: "button", name: "Menu" }, outcome: "overlay" } })] }),
          node({ id: "/about", kind: "route", title: "About" }),
        ],
        skipped: [],
        notes: [],
      },
    },
  };
}

async function project(prefix: string): Promise<ResolvedConfig> {
  const r = tmpProject(prefix);
  writeFileSync(r.configPath!, `export default { targets: [{ name: "app", url: ${JSON.stringify(base)} }] };\n`);
  const resolved = await loadConfig({ configPath: r.configPath! });
  await saveMap(resolved, map());
  return resolved;
}

/** A shot with a real (tiny) PNG behind it, so the sheet and the judge manifest have a file to name. */
async function shotFor(resolved: ResolvedConfig, screen: Screen, runId: string): Promise<ShotRecord> {
  const sharp = (await import("sharp")).default;
  const slug = screen.route === "/" ? "root" : screen.route.slice(1);
  const rel = `web/app/${slug}/${screen.state}--desktop-dark.png`;
  const abs = join(evidenceDir(resolved), rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const png = await sharp({ create: { width: 200, height: 120, channels: 3, background: screen.state === "rest" ? "#123456" : "#654321" } }).png().toBuffer();
  writeFileSync(abs, png);
  return {
    id: `web/app/${slug}/${screen.state}/desktop/dark`,
    target: "app",
    route: screen.route,
    routeName: screen.routeName,
    state: screen.state,
    platform: "web",
    formFactor: "desktop",
    scheme: "dark",
    path: rel,
    hash: `hash-${screen.id}`,
    bytes: png.byteLength,
    width: 200,
    height: 120,
    animated: false,
    capturedAt: "2026-09-09T00:00:00.000Z",
    runId,
    deterministicFindings: [],
  };
}

interface Trace {
  replayed: string[];
  reached: string[];
  recorded: string[];
  reportsSeen: number[];
}

function seams(resolved: ResolvedConfig, trace: Trace, unreachable: Set<string> = new Set()): WalkPlan["seams"] {
  const reach = async (how: "replay" | "navigator", screen: Screen, ctx: ReachContext): Promise<ReachResult> => {
    // The cumulative report is on disk while the next screen is being reached.
    const reportPath = join(evidenceDir(resolved), "judge-report.json");
    if (existsSync(reportPath)) trace.reportsSeen.push((JSON.parse(readFileSync(reportPath, "utf8")) as WalkOutcome).stops.length);
    if (unreachable.has(screen.id)) return { ok: false, reason: "the fake could not reach it", lastLook: "navigate/look-1.jpg", costUsd: 0.02, navigatorCalls: 1, seconds: 1 };
    const shots = [await shotFor(resolved, screen, ctx.runId)];
    await mergeRun(resolved, { id: ctx.runId, kind: "web", startedAt: "t", finishedAt: "t", flags: {}, failures: [], skips: [] }, shots);
    const recorded = [
      { tool: "open" as const, args: { path: screen.route }, outcome: {}, at: "t" },
      ...(screen.state === "rest" ? [] : [{ tool: "click" as const, args: { affordance: { selector: "", role: "button", name: "Menu", href: null } }, outcome: { navigated: false }, at: "t" }]),
    ];
    return { ok: true, how, shots, recorded, costUsd: how === "navigator" ? 0.05 : 0, navigatorCalls: how === "navigator" ? 1 : 0, seconds: 1 };
  };
  return {
    replayScreen: async (screen, ctx) => {
      trace.replayed.push(screen.id);
      return reach("replay", screen, ctx);
    },
    reachScreen: async (screen, ctx) => {
      trace.reached.push(screen.id);
      return reach("navigator", screen, ctx);
    },
    recordReach: async (stop, result) => {
      trace.recorded.push(`${stop.id}:${result.ok ? "ok" : "failed"}`);
      const { mapWriter } = await import("../src/check/walk-reach.js");
      await mapWriter(resolved)(stop, result);
    },
  };
}

async function walk(resolved: ResolvedConfig, flags: Record<string, string | boolean>, s: WalkPlan["seams"], runId = "check-walk-test"): Promise<{ code: number; outcome: WalkOutcome; events: ReturnType<typeof readEvents> }> {
  const m = (await loadMap(resolved))!;
  const log = new EventLog(resolved, runId);
  log.start("lookout check", { project: "app" });
  setCurrentLog(log);
  const code = await walkMap({ positionals: [], flags: { panels: "judge-geometry", quiet: true, ...flags } }, resolved, { map: m, ensured: { map: m, stale: [], refreshed: [], costUsd: 0 }, seams: s }, runId);
  setCurrentLog(null);
  const outcome = JSON.parse(readFileSync(join(evidenceDir(resolved), "judge-report.json"), "utf8")) as WalkOutcome;
  return { code, outcome, events: readEvents(resolved) };
}

describe("walkMap", () => {
  test("one screen at a time, in order: replay for routes, the navigator for an unrecorded state, the ledger and report written as it goes, the recording written back", async () => {
    const resolved = await project("lookout-walk-full-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const argv = join(resolved.projectDir, "argv.jsonl");
    process.env.MOCK_ARGV_FILE = argv;
    const trace: Trace = { replayed: [], reached: [], recorded: [], reportsSeen: [] };
    const { code, outcome, events } = await walk(resolved, {}, seams(resolved, trace));

    expect(trace.replayed).toEqual(["app|/|rest", "app|/about|rest"]);
    expect(trace.reached).toEqual(["app|/|menu-open"]);
    expect(trace.recorded).toEqual(["app|/|menu-open:ok"]);
    expect(trace.reportsSeen).toEqual([1, 2]);
    expect(outcome.stops.map((s) => `${s.screen}:${s.status}:${s.how}`)).toEqual(["app|/|rest:judged:replay", "app|/|menu-open:judged:navigator", "app|/about|rest:judged:replay"]);
    expect(outcome.screens).toEqual({ total: 3, walked: 3, judged: 3, cached: 0, unjudged: 0, unreachable: 0, notWalked: 0 });
    expect(outcome.navigator).toEqual({ calls: 1, replays: 2, costUsd: 0.05 });
    // The mock judge files one finding per screen; the walk exits on standing findings.
    expect(outcome.findings.length).toBeGreaterThanOrEqual(3);
    expect(code).toBe(1);
    // One panel per screen, judged in walk order.
    const prompts = readFileSync(argv, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as string[]).join(" "));
    const judgeCalls = prompts.filter((p) => p.includes("judge-geometry") || p.includes("## Category vocabulary"));
    expect(judgeCalls.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys((await loadLedger(resolved)).entries).length).toBeGreaterThanOrEqual(3);
    // The map remembers how the state was reached.
    const walked = nodeByScreen((await loadMap(resolved))!, "app", "/", "menu-open");
    expect(walked?.walk).toMatchObject({ reached: true, shotIds: ["web/app/root/menu-open/desktop/dark"] });
    expect(walked?.walk?.actions?.map((a) => a.tool)).toEqual(["open", "click"]);
    // The board saw it happen, in order.
    const kinds = events.map((e) => `${e.kind}:${e.message}`);
    expect(kinds.some((k) => k.startsWith("phase:walking 3 screen(s)"))).toBe(true);
    expect(kinds.indexOf("phase:screen app|/|rest (1/3): reaching")).toBeLessThan(kinds.indexOf("phase:screen app|/|rest (1/3): judging"));
    expect(kinds.indexOf("phase:screen app|/|rest (1/3): judging")).toBeLessThan(kinds.indexOf("phase:screen app|/|menu-open (2/3): reaching"));
    expect(kinds.filter((k) => k.startsWith("shot:"))).toHaveLength(0);
    expect(events.at(-1)?.kind).toBe("run-end");

    // A second walk replays everything and is served from the ledger.
    const again = await walk(resolved, {}, seams(resolved, { replayed: [], reached: [], recorded: [], reportsSeen: [] }), "check-walk-test-2");
    expect(again.outcome.stops.map((s) => s.status)).toEqual(["cached", "cached", "cached"]);
    expect(again.outcome.navigator.calls).toBe(0);
  }, 120_000);

  test("--first stops at the first screen with standing findings and says so the way the page reads it", async () => {
    const resolved = await project("lookout-walk-first-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const trace: Trace = { replayed: [], reached: [], recorded: [], reportsSeen: [] };
    const { code, events } = await walk(resolved, { first: true }, seams(resolved, trace));
    expect(code).toBe(1);
    expect(trace.replayed).toEqual(["app|/|rest"]);
    expect(trace.reached).toEqual([]);
    const note = events.find((e) => e.kind === "note" && typeof e.data?.checked === "number");
    expect(note?.data).toMatchObject({ route: "/", screen: "app|/|rest", checked: 1, of: 3, unit: "screen" });
    expect(Number(note?.data?.found)).toBeGreaterThan(0);
    expect(events.at(-1)?.kind).toBe("run-end");
  }, 120_000);

  test("an unreachable screen is recorded, never judged and never cached; --replay-only never spends a navigator", async () => {
    const resolved = await project("lookout-walk-unreach-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const trace: Trace = { replayed: [], reached: [], recorded: [], reportsSeen: [] };
    const { outcome, events } = await walk(resolved, {}, seams(resolved, trace, new Set(["app|/|menu-open"])));
    const stop = outcome.stops.find((s) => s.screen === "app|/|menu-open");
    expect(stop).toMatchObject({ status: "unreachable", reason: "the fake could not reach it", lastLook: "navigate/look-1.jpg", navigatorCalls: 2 });
    expect(outcome.screens.unreachable).toBe(1);
    expect(trace.reached).toEqual(["app|/|menu-open", "app|/|menu-open"]);
    expect(trace.recorded).toEqual(["app|/|menu-open:failed"]);
    expect(Object.keys((await loadLedger(resolved)).entries).some((k) => k.includes("menu-open"))).toBe(false);
    expect(readIncidents(resolved.projectDir).some((i) => i.kind === "screen-unreachable")).toBe(true);
    expect(events.some((e) => e.kind === "note" && e.data?.unreachable === true)).toBe(true);
    expect(nodeByScreen((await loadMap(resolved))!, "app", "/", "menu-open")?.walk).toMatchObject({ reached: false, reason: "the fake could not reach it" });

    const only: Trace = { replayed: [], reached: [], recorded: [], reportsSeen: [] };
    const r2 = await walk(resolved, { "replay-only": true }, seams(resolved, only), "check-walk-test-2");
    expect(only.reached).toEqual([]);
    expect(r2.outcome.stops.find((s) => s.screen === "app|/|menu-open")).toMatchObject({ status: "unreachable", reason: "no recording; run without --replay-only to record it" });
  }, 120_000);

  test("--max-screens and --budget-usd cut the walk and say which screens were not walked", async () => {
    const resolved = await project("lookout-walk-caps-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const capped = await walk(resolved, { "max-screens": "1" }, seams(resolved, { replayed: [], reached: [], recorded: [], reportsSeen: [] }));
    expect(capped.outcome.stops.map((s) => s.status)).toEqual(["judged", "not-walked", "not-walked"]);
    expect(capped.outcome.screens.notWalked).toBe(2);
    expect(capped.events.filter((e) => e.kind === "note" && e.data?.notWalked === "cap")).toHaveLength(2);

    // The budget is checked before each screen: the first screen is served
    // from the ledger for nothing, the second is the one that spends, and
    // the third is where the walk stops.
    const budget = await walk(resolved, { "budget-usd": "0" }, seams(resolved, { replayed: [], reached: [], recorded: [], reportsSeen: [] }), "check-walk-test-2");
    expect(budget.outcome.stops.map((s) => s.status)).toEqual(["cached", "judged", "not-walked"]);
    expect(budget.outcome.stops[2]).toMatchObject({ reason: "budget of $0 exceeded" });
  }, 120_000);

  test("every screen unreachable is an error, not a clean run", async () => {
    const resolved = await project("lookout-walk-none-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    await expect(walk(resolved, {}, seams(resolved, { replayed: [], reached: [], recorded: [], reportsSeen: [] }, new Set(["app|/|rest", "app|/|menu-open", "app|/about|rest"])))).rejects.toThrow(/no screen could be reached/);
  }, 120_000);
});
