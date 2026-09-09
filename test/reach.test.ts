// Reaching a screen for the walk. Replay runs the recording in-process with
// no AI and lands the shots in the capture report under the walk's run;
// the navigator path believes the tool server's file over the model's
// reply. The page under test is served here; the model is the mock CLI.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadReport } from "../src/capture/store.js";
import { EventLog } from "../src/report/events.js";
import { preludeOf, reachScreen, replayScreen, type ReachContext, type Screen } from "../src/navigator/reach.js";
import type { MapNode } from "../src/map/store.js";
import type { NavAction } from "../src/mcp/actions.js";
import type { ResolvedConfig } from "../src/types.js";
import { tmpProject } from "./tmp-project.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head>
<body><a href="/about">About</a><button id="menu">Menu</button>
<dialog id="dlg"><h2>Menu</h2><button id="close">Close</button></dialog>
<script>document.getElementById("menu").addEventListener("click", () => document.getElementById("dlg").showModal());</script>
</body></html>`;

let app: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  app = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/about"
        ? new Response("<h1>About</h1>", { headers: { "content-type": "text/html" } })
        : new Response(PAGE, { headers: { "content-type": "text/html" } }),
  });
  base = `http://127.0.0.1:${app.port}`;
});

afterAll(() => app.stop(true));

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_NAVIGATE;
});

function node(partial: Partial<MapNode> & Pick<MapNode, "id" | "kind">): MapNode {
  return { title: partial.id, open: null, risk: "safe", platforms: ["web"], source: { path: "/repo/src/App.tsx" }, why: "", children: [], ...partial };
}

const CLICK_MENU: NavAction[] = [
  { tool: "open", args: { path: "/" }, outcome: {}, at: "t" },
  { tool: "click", args: { affordance: { selector: "#menu", role: "button", name: "Menu", href: null } }, outcome: { navigated: false }, at: "t" },
];

async function project(prefix: string): Promise<ResolvedConfig> {
  const r = tmpProject(prefix);
  writeFileSync(r.configPath!, `export default { targets: [{ name: "app", url: ${JSON.stringify(base)} }] };\n`);
  return loadConfig({ configPath: r.configPath! });
}

function context(resolved: ResolvedConfig, over: Partial<ReachContext> = {}): ReachContext {
  return {
    resolved,
    runId: "check-walk-1",
    platforms: ["web"],
    formFactors: ["desktop"],
    schemes: ["dark"],
    capture: { settleMs: 50, axe: "off", axeContrast: false, provenance: false, aria: false, edgeClip: false, headless: true },
    navigator: { ai: "claude-code", model: "sonnet", timeoutMs: 60_000 },
    log: EventLog.attach(resolved, "check-walk-1"),
    ...over,
  };
}

function screen(over: Partial<Screen> & Pick<Screen, "node">): Screen {
  const n = over.node;
  return {
    id: `app|/|${n.kind === "route" ? "rest" : n.id}`,
    target: "app",
    route: "/",
    routeName: "Home",
    state: n.kind === "route" ? "rest" : n.id,
    chain: [],
    platforms: ["web"],
    allowDestructive: false,
    ...over,
  };
}

describe("preludeOf", () => {
  test("concatenates the ancestors' recordings without their opens, and is null when one was never reached", () => {
    const reached = node({ id: "menu-open", kind: "state", walk: { reached: true, actions: CLICK_MENU } });
    expect(preludeOf([reached])?.map((a) => a.tool)).toEqual(["click"]);
    expect(preludeOf([])).toEqual([]);
    expect(preludeOf([node({ id: "unreached", kind: "state" })])).toBeNull();
    expect(preludeOf([node({ id: "failed", kind: "state", walk: { reached: false } })])).toBeNull();
  });
});

describe("replayScreen", () => {
  test("a route screen is opened and photographed, and its shots land in the report under the walk's run", async () => {
    const resolved = await project("lookout-reach-rest-");
    const r = await replayScreen(screen({ node: node({ id: "/", kind: "route", path: "/" }) }), context(resolved));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.how).toBe("replay");
    expect(r.shots.map((s) => `${s.state}/${s.formFactor}/${s.scheme}`)).toEqual(["rest/desktop/dark"]);
    const report = await loadReport(resolved);
    expect(report?.runs.map((x) => x.id)).toEqual(["check-walk-1"]);
    expect(report?.shots.map((s) => s.id)).toEqual(["web/app/root/rest/desktop/dark"]);
  }, 60_000);

  test("a state screen replays its recording and photographs the state; a recording that lands elsewhere is refused", async () => {
    const resolved = await project("lookout-reach-state-");
    const menu = node({ id: "menu-open", kind: "state", title: "the menu", walk: { reached: true, actions: CLICK_MENU } });
    const ok = await replayScreen(screen({ node: menu }), context(resolved));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.shots[0]).toMatchObject({ state: "menu-open", stateDescription: "the menu" });

    const wrong = node({
      id: "goto-about",
      kind: "state",
      walk: {
        reached: true,
        actions: [CLICK_MENU[0]!, { tool: "click", args: { affordance: { selector: "", role: "link", name: "About", href: null } }, outcome: { navigated: false }, at: "t" }],
      },
    });
    const bad = await replayScreen(screen({ node: wrong }), context(resolved));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/navigated, but the recording says it did not/);

    const never = await replayScreen(screen({ node: node({ id: "fresh", kind: "state" }) }), context(resolved));
    expect(never).toMatchObject({ ok: false, reason: "no recording for this screen" });
    const orphan = await replayScreen(screen({ node: menu, chain: [node({ id: "parent", kind: "state" })] }), context(resolved));
    expect(orphan).toMatchObject({ ok: false, reason: "a screen above this one has no recording yet" });
  }, 90_000);
});

describe("reachScreen", () => {
  test("a navigator that could not reach the screen is believed, and nothing is merged", async () => {
    const resolved = await project("lookout-reach-nav-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const r = await reachScreen(screen({ node: node({ id: "menu-open", kind: "state" }) }), context(resolved));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("the mock does not drive a browser");
    expect(r.navigatorCalls).toBe(1);
    expect(r.costUsd).toBeGreaterThan(0);
    expect((await loadReport(resolved))?.shots ?? []).toEqual([]);
  }, 60_000);

  test("a navigator that says it arrived is not believed when the tool server recorded no capture", async () => {
    const resolved = await project("lookout-reach-claim-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_NAVIGATE = JSON.stringify({ arrived: true, screen: "app|/|menu-open", steps: 2, note: "trust me" });
    const r = await reachScreen(screen({ node: node({ id: "menu-open", kind: "state" }) }), context(resolved));
    expect(r).toMatchObject({ ok: false, reason: "the navigator said it arrived, but the tool server recorded no capture" });
  }, 60_000);
});
