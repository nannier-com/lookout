// The web driver end to end, through the protocol, against a page this test
// serves: open, snapshot, click by reference, the refusals (a form submit, an
// excluded control, a link that leaves the origin), and arrive, which writes
// the record; then the recording replayed in-process at another width.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { mcpServerSpec } from "../src/mcp/spec.js";
import { DEFAULT_LIMITS, readNavSession, writeNavSession, type NavSessionInput } from "../src/mcp/session.js";
import { replayWeb } from "../src/mcp/replay-web.js";
import { evidenceDir } from "../src/config.js";
import { tmpProject } from "./tmp-project.js";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>
<style>body{margin:0;font-family:sans-serif} dialog{padding:16px}</style></head>
<body><header><a href="/about">About</a><a id="away" href="AWAY">Elsewhere</a>
<button id="menu">Menu</button><button id="danger">Danger zone</button></header>
<form action="/submit" method="post"><input name="q" aria-label="Query"><button>Submit</button></form>
<dialog id="dlg"><h2>Menu</h2><button id="close">Close</button></dialog>
<script>
document.getElementById("menu").addEventListener("click", () => document.getElementById("dlg").showModal());
document.getElementById("close").addEventListener("click", () => document.getElementById("dlg").close());
</script></body></html>`;

let app: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<h1>elsewhere</h1>", { headers: { "content-type": "text/html" } }) });
  app = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/about") return new Response("<h1>About</h1>", { headers: { "content-type": "text/html" } });
      if (url.pathname === "/submit") return new Response("<h1>Submitted</h1>", { headers: { "content-type": "text/html" } });
      return new Response(PAGE.replace("AWAY", `http://127.0.0.1:${other.port}/`), { headers: { "content-type": "text/html" } });
    },
  });
  base = `http://127.0.0.1:${app.port}`;
});

afterAll(() => {
  app.stop(true);
  other.stop(true);
});

function session(configPath: string): NavSessionInput {
  return {
    configPath,
    runId: "check-web-test",
    target: "app",
    platform: "web",
    screen: { id: "app|/|menu-open", route: "/", routeName: "Home", state: "menu-open", description: "the menu is open" },
    prelude: [],
    matrix: { formFactors: ["desktop", "phone"], schemes: ["dark"] },
    capture: { settleMs: 50, axe: "off", axeContrast: false, provenance: false, aria: false, edgeClip: false, headless: true },
    exclude: ["Danger"],
    include: [],
    allowDestructive: false,
    limits: DEFAULT_LIMITS,
  };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
}

describe("the web driver through the protocol", () => {
  test("open, snapshot, click by ref, the three refusals, and arrive", async () => {
    const r = tmpProject("lookout-mcp-web-");
    writeFileSync(r.configPath!, `export default { targets: [{ name: "app", url: ${JSON.stringify(base)} }] };\n`);
    const path = await writeNavSession(r, session(r.configPath!));
    const spec = mcpServerSpec(path);
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, stderr: "pipe" });
    const client = new Client({ name: "lookout-test", version: "1" });
    await client.connect(transport);
    try {
      const opened = text(await client.callTool({ name: "open", arguments: { path: "/" } }));
      expect(opened).toContain(`opened ${base}/`);
      expect(opened).toMatch(/- a\d+ \[button\] "Menu"/);
      const ref = /- (a\d+) \[button\] "Menu"/.exec(opened)![1]!;

      const submit = await client.callTool({ name: "click", arguments: { role: "button", name: "Submit" } });
      expect(submit.isError).toBe(true);
      expect(text(submit)).toContain("submits a form");

      const danger = await client.callTool({ name: "click", arguments: { role: "button", name: "Danger zone" } });
      expect(danger.isError).toBe(true);
      expect(text(danger)).toContain("exclude");

      const away = await client.callTool({ name: "click", arguments: { role: "link", name: "Elsewhere" } });
      expect(away.isError).toBe(true);
      expect(text(away)).toContain("left the target's origin");

      const clicked = text(await client.callTool({ name: "click", arguments: { ref } }));
      expect(clicked).toContain('click button "Menu": done');
      expect(clicked).toMatch(/\[button\] "Close"/);

      const looked = await client.callTool({ name: "look", arguments: {} });
      expect((looked.content as { type: string }[]).some((c) => c.type === "image")).toBe(true);

      const arrived = text(await client.callTool({ name: "arrive", arguments: { note: "clicked Menu" } }));
      expect(arrived).toContain("captured 2 shot(s) of app|/|menu-open");

      const again = await client.callTool({ name: "click", arguments: { ref } });
      expect(again.isError).toBe(true);
      expect(text(again)).toContain("has been captured");
    } finally {
      await client.close();
    }

    const deadline = Date.now() + 10_000;
    let result = (await readNavSession(path)).result;
    while ((!result || !result.arrived) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100));
      result = (await readNavSession(path)).result;
    }
    expect(result?.arrived).toBe(true);
    expect(result?.failures).toEqual([]);
    expect(result?.shots.map((s) => `${s.state}/${s.formFactor}/${s.scheme}`).sort()).toEqual(["menu-open/desktop/dark", "menu-open/phone/dark"]);
    for (const shot of result!.shots) expect(existsSync(join(evidenceDir(r), shot.path))).toBe(true);
    // The recording names the control, never the snapshot reference.
    expect(result?.actions.map((a) => a.tool)).toEqual(["open", "click"]);
    expect(result?.actions[1]?.args.affordance).toMatchObject({ role: "button", name: "Menu" });
    expect(result?.actions[1]?.outcome.navigated).toBe(false);
    expect(result?.arrival?.sampleNames).toContain("Close");
    expect(["the conversation ended", "terminated"]).toContain(result?.note ?? "");
    // The shots' state carries the recipe's description.
    expect(result?.shots[0]?.stateDescription).toBe("the menu is open");

    // The events landed on the run the session named, not on a run of the server's own.
    const events = readFileSync(join(evidenceDir(r), "events.jsonl"), "utf8");
    expect(events).toContain('"kind":"shot"');
    expect(events).not.toContain('"kind":"run-start"');
    expect(events).toContain("navigator: click button");
  }, 120_000);

  test("the recording replays in-process at another width and reaches the same screen", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const ctx = { targetUrl: base, urlFor: (p: string) => `${base}${p}`, exclude: [], allowDestructive: false };
      await replayWeb(
        page,
        [
          { tool: "open", args: { path: "/" }, outcome: {}, at: "t" },
          { tool: "click", args: { affordance: { selector: "#menu", role: "button", name: "Menu", href: null } }, outcome: { navigated: false }, at: "t" },
        ],
        ctx,
      );
      expect(await page.locator("dialog[open]").count()).toBe(1);

      // A click the recording says did not navigate, but does now, stops the
      // replay (from a fresh rest, so the open dialog is not what blocks it).
      await page.goto(base);
      await expect(
        replayWeb(page, [{ tool: "click", args: { affordance: { selector: "", role: "link", name: "About", href: null } }, outcome: { navigated: false }, at: "t" }], ctx),
      ).rejects.toThrow(/navigated, but the recording says it did not/);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
