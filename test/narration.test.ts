// The narration channel: what the page reads to show a judge working. It is a
// tail, not a record, so what matters is that it stays small, stays ordered,
// and never costs a run anything when nothing is listening.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../src/config.js";
import {
  Narration,
  closeCall,
  narrating,
  narrationPath,
  openCall,
  readNarration,
  say,
  setCurrentNarration,
} from "../src/report/narration.js";
import "./setup.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-narration-"));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const r = {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
  mkdirSync(evidenceDir(r), { recursive: true });
  return r;
}

afterEach(() => setCurrentNarration(null));

describe("gathering what a judge says", () => {
  test("prose is coalesced rather than written a token at a time", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    for (const t of ["the ", "card ", "title ", "is ", "fine"]) n.say("c1", "judge-craft", { kind: "text", text: t });
    n.flush();
    const lines = readNarration(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("the card title is fine");
    expect(lines[0]!.panel).toBe("judge-craft");
  });

  test("a tool call lands in its place, with the prose either side of it", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    n.say("c1", "judge-text", { kind: "text", text: "looking" });
    n.say("c1", "judge-text", { kind: "tool", text: "Read /shots/a.png" });
    n.say("c1", "judge-text", { kind: "text", text: "read it" });
    n.flush();
    expect(readNarration(r).map((l) => `${l.kind}:${l.text}`)).toEqual([
      "text:looking",
      "tool:Read /shots/a.png",
      "text:read it",
    ]);
  });

  test("changing judge closes the previous one's sentence", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    n.say("c1", "judge-text", { kind: "text", text: "mine" });
    n.say("c2", "judge-craft", { kind: "text", text: "ours" });
    n.flush();
    const lines = readNarration(r);
    expect(lines.map((l) => `${l.panel}:${l.text}`)).toEqual(["judge-text:mine", "judge-craft:ours"]);
  });

  // The defect this keys on: a check runs two workers over two view groups and
  // both reach the same panel at the same time, so buffering by NAME spliced
  // two verdicts into one run of prose. Reassembled, it carried two JSON
  // replies shredded together with nothing to say which view either belonged to.
  test("two calls to the same judge at once do not splice into one another", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    n.mark("cA", "judge-integrity", "open", "app/index · 6 shot(s)");
    n.mark("cB", "judge-integrity", "open", "app/settings · 6 shot(s)");
    for (const [call, word] of [
      ["cA", "the "], ["cB", "a "], ["cA", "index "], ["cB", "settings "], ["cA", "verdict"], ["cB", "verdict"],
    ] as const) {
      n.say(call, "judge-integrity", { kind: "text", text: word });
    }
    n.mark("cA", "judge-integrity", "close", "");
    n.mark("cB", "judge-integrity", "close", "");
    const byCall = new Map<string, string>();
    for (const l of readNarration(r)) {
      if (l.kind === "text") byCall.set(l.call, (byCall.get(l.call) ?? "") + l.text);
    }
    expect(byCall.get("cA")).toBe("the index verdict");
    expect(byCall.get("cB")).toBe("a settings verdict");
  });

  test("a call that closes stops being held open", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    n.say("c1", "judge-text", { kind: "text", text: "unfinished" });
    n.mark("c1", "judge-text", "close", "");
    // The close flushed it, so a whole-run flush afterwards has nothing left to
    // write and cannot repeat it.
    n.flush();
    expect(readNarration(r).filter((l) => l.kind === "text")).toHaveLength(1);
  });

  test("a call is bracketed, which is what progress is counted in", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    n.mark("c1", "judge-geometry", "open", "judging 6 shot(s)");
    n.mark("c1", "judge-geometry", "close", "");
    expect(readNarration(r).map((l) => l.kind)).toEqual(["open", "close"]);
  });

  test("a new run does not inherit the last one's narration", () => {
    const r = project();
    const first = new Narration(r, "check-1");
    first.start();
    first.mark("c1", "judge-text", "open", "one");
    const second = new Narration(r, "check-2");
    second.start();
    second.mark("c2", "judge-text", "open", "two");
    expect(readNarration(r).map((l) => l.text)).toEqual(["two"]);
  });
});

describe("staying a tail", () => {
  test("the file is trimmed rather than grown without limit", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    // Past the trim threshold by enough to be sure it fired more than once.
    for (let i = 0; i < 1600; i++) n.mark(`c${i}`, "judge-text", "open", `line ${i}`);
    const lines = readFileSync(narrationPath(r), "utf8").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(1200);
    // The tail is what survives: the newest line is still there.
    expect(lines[lines.length - 1]).toContain("line 1599");
  });

  test("a torn last line is skipped, not thrown on", () => {
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    n.mark("c1", "judge-text", "open", "whole");
    writeFileSync(narrationPath(r), readFileSync(narrationPath(r), "utf8") + '{"at":"2026', { flag: "w" });
    expect(readNarration(r)).toHaveLength(1);
  });
});

describe("costing nothing when nobody is listening", () => {
  test("narrating is false until a run installs one", () => {
    expect(narrating()).toBe(false);
    const r = project();
    const n = new Narration(r, "check-1");
    n.start();
    setCurrentNarration(n);
    expect(narrating()).toBe(true);
    setCurrentNarration(null);
    expect(narrating()).toBe(false);
  });

  test("saying something with no run in flight is a no-op, not a crash", () => {
    setCurrentNarration(null);
    const call = openCall("judge-text", "also the void");
    say(call, "judge-text", { kind: "text", text: "into the void" });
    closeCall(call, "judge-text");
    expect(narrating()).toBe(false);
  });

  test("every call gets its own id even for the same judge", () => {
    expect(openCall("judge-text", "one")).not.toBe(openCall("judge-text", "two"));
  });
});
