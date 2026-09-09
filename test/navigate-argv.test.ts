// A navigate capability reaches each CLI as that CLI's own way of attaching
// a tool server: the server spec inline, no other server, the tools
// allow-listed by the name the CLI gives them, and no file tools unless they
// were asked for too. Without a session there is nothing to attach, and the
// call is refused before a subprocess starts.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter, claudeTools, navigationArgs } from "../src/judge/claude.js";
import { codexAdapter, navigationOverrides } from "../src/judge/codex.js";
import { mcpEntry } from "../src/mcp/spec.js";
import { tmpProject } from "./tmp-project.js";

const CLAUDE = join(import.meta.dir, "mock-claude.ts");
const CODEX = join(import.meta.dir, "mock-codex.ts");

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.LOOKOUT_CODEX_BIN;
  delete process.env.MOCK_ARGV_FILE;
});

describe("the tool names", () => {
  test("navigate adds every server tool under the CLI's prefix and, alone, no file tool", () => {
    const names = claudeTools(["navigate"]);
    expect(names).toContain("mcp__lookout__snapshot");
    expect(names).toContain("mcp__lookout__arrive");
    expect(names).not.toContain("Read");
    expect(claudeTools(["read-files", "navigate"])).toContain("Read");
  });

  test("both adapters say they navigate, and say how to call the tools", () => {
    expect(claudeAdapter.navigates).toBe(true);
    expect(claudeAdapter.navigateInstruction).toContain("mcp__lookout__");
    expect(codexAdapter.navigates).toBe(true);
    expect(codexAdapter.navigateInstruction).toContain("lookout");
  });
});

describe("the flags", () => {
  test("a navigate capability without a session is refused before anything is spawned", () => {
    expect(() => navigationArgs({ prompt: "x", model: "m", capabilities: ["navigate"] })).toThrow(/session file/);
    expect(() => navigationOverrides({ prompt: "x", model: "m", capabilities: ["navigate"] })).toThrow(/session file/);
    expect(navigationArgs({ prompt: "x", model: "m" })).toEqual([]);
    expect(navigationOverrides({ prompt: "x", model: "m" })).toEqual([]);
  });

  test("Claude gets the server inline, strictly, and the tools by their prefixed names", async () => {
    const r = tmpProject("lookout-argv-claude-");
    const argv = join(r.projectDir, "argv.jsonl");
    process.env.LOOKOUT_CLAUDE_BIN = CLAUDE;
    process.env.MOCK_ARGV_FILE = argv;
    process.env.MOCK_MODE = "ask";
    try {
      await claudeAdapter.invoke({ prompt: "reach the screen", model: "m", capabilities: ["navigate"], navigation: { sessionPath: "/tmp/s.json" } });
    } finally {
      delete process.env.MOCK_MODE;
    }
    const args = JSON.parse(readFileSync(argv, "utf8").trim().split("\n")[0]!) as string[];
    expect(args[args.indexOf("--allowedTools") + 1]!.split(",")).toEqual(expect.arrayContaining(["mcp__lookout__open", "mcp__lookout__arrive"]));
    expect(args[args.indexOf("--allowedTools") + 1]!).not.toContain("Read");
    expect(args).toContain("--strict-mcp-config");
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
    expect(config.mcpServers.lookout).toMatchObject({ type: "stdio", command: process.execPath, args: [mcpEntry(), "--session", "/tmp/s.json"] });
  });

  test("Codex gets the server as config overrides in its own dotted vocabulary", async () => {
    const r = tmpProject("lookout-argv-codex-");
    const argv = join(r.projectDir, "argv.jsonl");
    process.env.LOOKOUT_CODEX_BIN = CODEX;
    process.env.MOCK_ARGV_FILE = argv;
    await codexAdapter.invoke({ prompt: "reach the screen", model: "m", capabilities: ["navigate"], navigation: { sessionPath: "/tmp/s.json" } });
    const args = JSON.parse(readFileSync(argv, "utf8").trim().split("\n")[0]!) as string[];
    const overrides = args.filter((_, i) => args[i - 1] === "-c");
    expect(overrides).toEqual([
      `mcp_servers.lookout.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.lookout.args=${JSON.stringify([mcpEntry(), "--session", "/tmp/s.json"])}`,
      "mcp_servers.lookout.startup_timeout_sec=60",
      "mcp_servers.lookout.tool_timeout_sec=600",
    ]);
    // Still read-only, still ignoring the operator's own config: the server
    // lookout attached is the only one this conversation has.
    expect(args).toContain("--ignore-user-config");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args[args.length - 1]).toBe("reach the screen");
  });
});
