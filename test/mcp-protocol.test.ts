// The tool server speaks the protocol its clients expect: it initialises,
// lists the tools of the session's platform, refuses an unknown tool as a
// result rather than a crash, and leaves a result in the session file when
// the conversation ends. No browser: nothing here calls open.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { mcpEntry, mcpServerSpec, mcpToolNames, SERVER_NAME } from "../src/mcp/spec.js";
import { DEFAULT_LIMITS, readNavSession, writeNavSession, type NavSessionInput } from "../src/mcp/session.js";
import { tmpProject } from "./tmp-project.js";

function session(configPath: string, over: Partial<NavSessionInput> = {}): NavSessionInput {
  return {
    configPath,
    runId: "check-test",
    target: "app",
    platform: "web",
    screen: { id: "app|/|rest", route: "/", routeName: "Home", state: "rest" },
    prelude: [],
    matrix: { formFactors: ["desktop"], schemes: ["dark"] },
    capture: { settleMs: 50, axe: "off", axeContrast: false, provenance: false, aria: false, edgeClip: false, headless: true },
    exclude: [],
    include: [],
    allowDestructive: false,
    limits: DEFAULT_LIMITS,
    ...over,
  };
}

async function connect(sessionPath: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const spec = mcpServerSpec(sessionPath);
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, stderr: "pipe" });
  const client = new Client({ name: "lookout-test", version: "1" });
  await client.connect(transport);
  return { client, transport };
}

describe("the spec", () => {
  test("names the server, finds its entry, and lists the tools the adapters allow", () => {
    expect(SERVER_NAME).toBe("lookout");
    expect(mcpEntry()).toMatch(/[/\\]mcp\.(ts|js)$/);
    const spec = mcpServerSpec("/tmp/s.json");
    expect(spec.command).toBe(process.execPath);
    expect(spec.args.slice(-2)).toEqual(["--session", "/tmp/s.json"]);
    expect(mcpToolNames()).toContain("arrive");
    expect(mcpToolNames()).toContain("snapshot");
  });
});

describe("the tool server over stdio", () => {
  test("initialises, lists the web tools, refuses an unknown tool as an error result, and records the end", async () => {
    const r = tmpProject("lookout-mcp-proto-");
    const path = await writeNavSession(r, session(r.configPath!));
    const { client, transport } = await connect(path);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["arrive", "back", "click", "hover", "look", "open", "press", "scroll", "snapshot", "type", "wait"]);
      expect(tools.tools.find((t) => t.name === "click")?.inputSchema).toMatchObject({ type: "object" });

      // A refusal is a result the model reads, never a protocol error.
      const arrived = await client.callTool({ name: "arrive", arguments: {} });
      expect(arrived.isError).toBe(true);
      expect(JSON.stringify(arrived.content)).toContain("open the route first");

      const clicked = await client.callTool({ name: "click", arguments: { ref: "a1" } });
      expect(clicked.isError).toBe(true);
      expect(JSON.stringify(clicked.content)).toContain("call snapshot first");

      // A tool that does not exist is answered the same way: as a result the
      // model reads, saying so.
      const nope = await client.callTool({ name: "nope", arguments: {} });
      expect(nope.isError).toBe(true);
      expect(JSON.stringify(nope.content)).toContain("not found");
    } finally {
      await client.close();
    }
    // The server writes its record and exits once the conversation ends,
    // whether the client closed its stdin or sent it a signal.
    const deadline = Date.now() + 10_000;
    let result = (await readNavSession(path)).result;
    while (!result && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100));
      result = (await readNavSession(path)).result;
    }
    expect(result?.arrived).toBe(false);
    expect(["the conversation ended", "terminated"]).toContain(result?.note ?? "");
    expect(result?.calls.map((c) => c.tool)).toEqual([undefined, "arrive", "click"]);
    expect(transport.pid).toBeDefined();
  }, 30_000);

  test("a session file that is not there is a clean exit, not a hang", async () => {
    const spec = mcpServerSpec(join(tmpProject("lookout-mcp-missing-").projectDir, "nope.json"));
    const proc = Bun.spawn([spec.command, ...spec.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("no navigation session");
  }, 20_000);
});
