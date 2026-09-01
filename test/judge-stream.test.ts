// The subprocess contract: what the caller is told while the model works, and
// when the call is allowed to finish. The second half is the one that cost real
// time. `execFile` completed on stdout reaching end-of-file, which anything
// outliving the CLI and holding the inherited pipe can defer indefinitely;
// runs were measured idling for the full ten-minute timeout with the verdict
// already written. Reading the stream means the end of the answer is seen.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeClaude } from "../src/judge/claude.js";
import { ReplyStream } from "../src/judge/stream.js";
import "./setup.js";

/** A stand-in `claude` that prints the given lines, then does whatever `after` says. */
function fakeCli(lines: string[], after = "", before = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "lookout-cli-"));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    "#!/bin/sh\n" + before + "\n" +
      lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("\n") +
      "\n" + after + "\nexit 0\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}

const RESULT = JSON.stringify({ type: "result", is_error: false, result: "the verdict", total_cost_usd: 0.5 });

describe("the reply stream", () => {
  test("reassembles text deltas that arrive split across chunks", () => {
    const said: string[] = [];
    const s = new ReplyStream((say) => said.push(say.kind + ":" + say.text));
    const delta = (t: string) =>
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
    // Deliberately cut mid-line: a socket does not respect line boundaries.
    const whole = delta("one") + "\n" + delta("two") + "\n";
    s.push(whole.slice(0, 40));
    s.push(whole.slice(40));
    expect(said).toEqual(["text:one", "text:two"]);
  });

  test("names the tool a turn called, and what it was pointed at", () => {
    const said: string[] = [];
    const s = new ReplyStream((say) => said.push(say.kind + ":" + say.text));
    s.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/shots/a.png" } }] },
      }) + "\n",
    );
    expect(said).toEqual(["tool:Read /shots/a.png"]);
  });

  test("a line that is not JSON is dropped rather than thrown on", () => {
    const s = new ReplyStream();
    s.push("Warning: something the CLI printed\n" + RESULT + "\n");
    expect(s.result?.result).toBe("the verdict");
  });
});

describe("finishing the call", () => {
  test("returns on the result line even while something still holds stdout open", async () => {
    // The grandchild inherits stdout and outlives the CLI, so end-of-file does
    // not arrive for five seconds. The answer is already on the wire.
    const bin = fakeCli([RESULT], "sleep 5 &");
    process.env.LOOKOUT_CLAUDE_BIN = bin;
    try {
      const started = Date.now();
      const res = await invokeClaude({ prompt: "x", cwd: tmpdir(), model: "sonnet" });
      expect(res.text).toBe("the verdict");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });

  test("narrates while it works, then answers", async () => {
    const bin = fakeCli([
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/s/b.png" } }] } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half " } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "a verdict" } } }),
      RESULT,
    ]);
    process.env.LOOKOUT_CLAUDE_BIN = bin;
    try {
      const said: string[] = [];
      const res = await invokeClaude({
        prompt: "x",
        cwd: tmpdir(),
        model: "sonnet",
        onSay: (s) => said.push(s.kind + ":" + s.text),
      });
      expect(said).toEqual(["tool:Read /s/b.png", "text:half ", "text:a verdict"]);
      expect(res.text).toBe("the verdict");
      expect(res.costUsd).toBe(0.5);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });

  test("a CLI that says nothing at all is an error, not an empty verdict", async () => {
    const bin = fakeCli([]);
    process.env.LOOKOUT_CLAUDE_BIN = bin;
    try {
      await expect(invokeClaude({ prompt: "x", cwd: tmpdir(), model: "sonnet" })).rejects.toThrow(
        /unparseable output/,
      );
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });

  test("an errored envelope is reported with the CLI's own words", async () => {
    const bin = fakeCli([JSON.stringify({ type: "result", is_error: true, result: "not logged in" })]);
    process.env.LOOKOUT_CLAUDE_BIN = bin;
    try {
      await expect(invokeClaude({ prompt: "x", cwd: tmpdir(), model: "sonnet" })).rejects.toThrow(
        /claude -p errored: not logged in/,
      );
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });

  test("partial messages are asked for only when somebody is listening", async () => {
    const seen = join(mkdtempSync(join(tmpdir(), "lookout-argv-")), "argv");
    // Recorded before the reply, because the call is settled the moment the
    // result line lands and the child is killed right behind it.
    const bin = fakeCli([RESULT], "", `printf '%s\\n' "$*" >> ${JSON.stringify(seen)}`);
    process.env.LOOKOUT_CLAUDE_BIN = bin;
    try {
      await invokeClaude({ prompt: "x", cwd: tmpdir(), model: "sonnet" });
      await invokeClaude({ prompt: "x", cwd: tmpdir(), model: "sonnet", onSay: () => {} });
      const lines = (await Bun.file(seen).text()).trim().split("\n");
      expect(lines[0]).not.toContain("--include-partial-messages");
      expect(lines[1]).toContain("--include-partial-messages");
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });
});
