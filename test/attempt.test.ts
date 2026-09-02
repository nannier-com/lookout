// One ruling's record, written by one module for both channels: the judge's
// account in one sentence, what lookout observed in the repository, and the
// attempt as state.json keeps it.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptRecord,
  judgeNoteFor,
  narrowingFlags,
  observeRepo,
  previousAttempt,
  recordAttempt,
} from "../src/verify/attempt.js";
import { loadState } from "../src/fix/state.js";
import { tmpProject } from "./tmp-project.js";

describe("the judge's account, one sentence, first cause first", () => {
  const base = { nothingChanged: false, baselineShots: 4, totalShots: 4, stillOpen: [], unmet: [], unclosable: [] };

  test("no baseline forecloses everything else", () => {
    expect(judgeNoteFor({ ...base, nothingChanged: true, baselineShots: 0, totalShots: 3 })).toContain(
      "no baseline: none of the 3 screenshot(s)",
    );
  });
  test("nothing changed is the app not being rebuilt", () => {
    expect(judgeNoteFor({ ...base, nothingChanged: true })).toContain("nothing changed: all 4 comparable");
  });
  test("a finding still filed speaks in the judge's own observed sentence", () => {
    expect(judgeNoteFor({ ...base, stillOpen: [{ observed: "the badge still covers the R" }] })).toBe(
      "the badge still covers the R",
    );
  });
  test("failing criteria are listed when nothing is still filed", () => {
    expect(judgeNoteFor({ ...base, unmet: [{ text: "A" }, { text: "B" }] })).toBe(
      "2 acceptance criteria still fail: A; B",
    );
    expect(judgeNoteFor({ ...base, unmet: [{ text: "A" }] })).toContain("1 acceptance criterion still fail");
  });
  test("unclosable members name their routes, and a clean pass says nothing", () => {
    // Three findings, two routes: the count is of findings, the list is of routes.
    expect(judgeNoteFor({ ...base, unclosable: [{ route: "/a" }, { route: "/a" }, { route: "/b" }] })).toContain(
      "3 finding(s) sit on pixels unchanged since they were filed (/a, /b)",
    );
    expect(judgeNoteFor(base)).toBe("");
  });
});

describe("what lookout observed in the repository", () => {
  function repo(): { dir: string; git: (args: string[]) => string } {
    const dir = mkdtempSync(join(tmpdir(), "lookout-attempt-"));
    const git = (args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir }).toString();
    git(["init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "one"]);
    return { dir, git };
  }

  test("HEAD, the dirty files, and what changed since the previous attempt's commit", async () => {
    const { dir, git } = repo();
    const first = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "a.txt"), "two\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "two"]);
    const second = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "b.txt"), "dirty\n");
    // lookout's own writes are not the fixer's uncommitted work.
    mkdirSync(join(dir, ".lookout"), { recursive: true });
    writeFileSync(join(dir, ".lookout", "backlog.json"), "{}");
    const o = await observeRepo(dir, first, second);
    expect(o?.head).toBe(second);
    expect(o?.dirty).toBe(true);
    expect(o?.dirtyFiles).toEqual(["b.txt"]);
    expect(o?.filesChanged).toEqual(["a.txt"]);
  });

  test("a clean tree says so, and the same commit twice changes nothing", async () => {
    const { dir, git } = repo();
    const head = git(["rev-parse", "HEAD"]).trim();
    const o = await observeRepo(dir, head, head);
    expect(o).toEqual({ head, dirty: false });
  });

  test("not a git checkout: nothing is observed rather than something invented", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-nogit-"));
    expect(await observeRepo(dir)).toBeUndefined();
  });
});

describe("the attempt as state.json keeps it", () => {
  test("nothing absent is written as empty, and the lists are bounded", () => {
    const a = attemptRecord({
      n: 2,
      commit: "deadbee",
      note: "raised the contrast",
      verdict: "still-open",
      judgeNote: "still there",
      spawned: [],
      runId: "verify-9",
      totalShots: 6,
      changedShots: 1,
      baselineShots: 6,
      stillOpen: Array.from({ length: 14 }, (_, i) => ({ title: `t${i}`, shotId: `s${i}`, observed: `o${i}` })),
      unclosable: [],
      criteria: [{ id: "c1", text: "A", verdict: "unmet", note: "no" }],
      contactSheet: null,
      flags: { viewports: "phone" },
      observed: { head: "deadbee", dirty: false },
    });
    expect(a.reported).toEqual({ commit: "deadbee", note: "raised the contrast" });
    expect(a.spawned).toBeUndefined();
    expect(a.unclosable).toBeUndefined();
    expect(a.contactSheet).toBeUndefined();
    expect(a.stillOpen).toHaveLength(10);
    expect(a.criteria).toEqual([{ id: "c1", text: "A", verdict: "unmet", note: "no" }]);
    expect(a.flags).toEqual({ viewports: "phone" });
    expect(a.observed).toEqual({ head: "deadbee", dirty: false });
    expect(Object.keys(a)).toEqual([
      "n", "dispatchedAt", "reported", "verdict", "judgeNote", "runId", "totalShots", "changedShots",
      "baselineShots", "stillOpen", "criteria", "flags", "observed",
    ]);
  });

  test("only the flags that narrow a ruling are kept", () => {
    expect(narrowingFlags({ issue: "1", commit: "x", viewports: "phone", "no-cache": true, json: true })).toEqual({
      viewports: "phone",
      "no-cache": true,
    });
    expect(narrowingFlags({ issue: "1" })).toBeUndefined();
  });

  test("recorded attempts round-trip, and the previous one is the last written", async () => {
    const r = tmpProject("lookout-attempt-state-");
    expect(await previousAttempt(r, "418203")).toBeUndefined();
    await recordAttempt(r, "418203", attemptRecord({ n: 1, commit: "aaa", verdict: "still-open" }));
    await recordAttempt(r, "418203", attemptRecord({ n: 2, commit: "bbb", verdict: "still-open", observed: { head: "bbb" } }));
    const state = await loadState(r, "418203");
    expect(state.attempts.map((a) => a.reported?.commit)).toEqual(["aaa", "bbb"]);
    expect((await previousAttempt(r, "418203"))?.observed).toEqual({ head: "bbb" });
  });
});
