// What lookout is allowed to put in the model menu.
//
// The menu exists because a list of model names baked into lookout would be
// wrong within a release while still looking authoritative. That only holds if
// every name comes from the install being described, so these tests build fake
// installs and assert lookout reports what THEY say: the declared aliases when
// the package ships its typings, the documented ones when it does not, and
// nothing at all when there is no CLI to ask.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCli } from "../src/judge/cli-probe.js";

/** A throwaway install: a package root, its typings, and a bin that answers. */
function fakeInstall(opts: { typings?: string; help?: string; version?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "lookout-cli-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code" }));
  if (opts.typings !== undefined) writeFileSync(join(root, "sdk-tools.d.ts"), opts.typings);
  mkdirSync(join(root, "bin"));
  const bin = join(root, "bin", "claude");
  writeFileSync(
    bin,
    "#!/bin/sh\n"
      + `case "$1" in\n`
      + `  --version) ${opts.version === undefined ? "echo '9.9.9 (Claude Code)'" : `echo '${opts.version}'`} ;;\n`
      + `  --help) cat <<'EOF'\n${opts.help ?? ""}\nEOF\n ;;\n`
      + "esac\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}

// The real package's shape: the aliases are a union on a field whose job is
// naming a model, and that field is what is read.
const TYPINGS = `export interface AgentInput {
  prompt: string;
  /** Optional model override for this agent. */
  model?: "sonnet" | "opus" | "haiku" | "fable";
  run_in_background?: boolean;
}`;

// The real CLI's help, shortened but shaped the same: the aliases are quoted
// inside the --model paragraph, and the next option ends it.
const HELP = `Options:
  --mcp-config <configs...>             Load MCP servers from 'a.json' or 'b.json'
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session`;

describe("what the installed CLI offers", () => {
  test("the aliases its own typings declare, and the version it prints", async () => {
    const facts = await probeCli(fakeInstall({ typings: TYPINGS, help: HELP }));
    expect(facts.models).toEqual(["sonnet", "opus", "haiku", "fable"]);
    // The version alone, not the product name it prints beside it: the menu is
    // already labelled with the tool.
    expect(facts.version).toBe("9.9.9");
  });

  test("the version is found wherever the CLI puts its own name", async () => {
    // One CLI prints `2.1.263 (Claude Code)` and another `codex-cli 0.153.4`.
    // Taking the leading token answers the second with its whole line.
    expect((await probeCli(fakeInstall({ version: "9.9.9 (Some Tool)" }))).version).toBe("9.9.9");
    expect((await probeCli(fakeInstall({ version: "some-cli 0.153.4" }))).version).toBe("0.153.4");
    // A CLI that versions itself in some way lookout did not anticipate is
    // quoted rather than dropped: what it said beats nothing.
    expect((await probeCli(fakeInstall({ version: "build alpha" }))).version).toBe("build alpha");
  });

  test("a newer CLI moves the menu without lookout being changed", async () => {
    const facts = await probeCli(
      fakeInstall({ typings: TYPINGS.replace('"fable"', '"fable" | "something-new-7"'), help: HELP }),
    );
    expect(facts.models).toContain("something-new-7");
  });

  test("falls back to what --help documents when the typings are not there", async () => {
    // An install whose binary is not inside its package, which is how a
    // wrapper script or a package manager's shim arrives.
    const facts = await probeCli(fakeInstall({ help: HELP }));
    expect(facts.models).toEqual(["fable", "opus", "sonnet", "claude-fable-5"]);
  });

  test("the help fallback reads only the model option, not its neighbours", async () => {
    const facts = await probeCli(fakeInstall({ help: HELP }));
    // 'a.json' and 'b.json' are quoted in the option above --model, and a
    // scrape of the whole help text would offer them as models.
    expect(facts.models).not.toContain("a.json");
    expect(facts.models).not.toContain("b.json");
  });

  test("a union on some other field is not a model list", async () => {
    const facts = await probeCli(
      fakeInstall({ typings: 'export interface X { effort?: "low" | "high"; }' }),
    );
    expect(facts.models).toEqual([]);
  });

  test("no CLI to ask means no menu and no version, rather than a guess", async () => {
    expect(await probeCli("lookout-no-such-binary-anywhere")).toEqual({ version: null, models: [] });
  });
});
