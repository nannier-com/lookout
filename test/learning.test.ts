// The record of lookout changing itself, gathered for the page that shows it.
//
// Both self-improvement verbs already write down what they did: `skills
// improve` appends to the project's history and leaves proposals it could not
// gate, `self-heal` keeps the diff and the gate output of every attempt a gate
// killed. Nothing here writes anything new. What is worth testing is that the
// gathering reads all of it, survives the half-written and the missing, and
// reports "running" from the same locks the verbs actually take.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLearning, learningBadge, learningKey } from "../src/report/learning.js";
import { improveLockPath } from "../src/verbs/skills.js";
import { tmpProject } from "./tmp-project.js";

const HOME = process.env.LOOKOUT_HOME;

afterEach(() => {
  if (HOME === undefined) delete process.env.LOOKOUT_HOME;
  else process.env.LOOKOUT_HOME = HOME;
});

/** A machine-wide lookout home nothing else is writing to. */
function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lookout-learning-home-"));
  process.env.LOOKOUT_HOME = dir;
  return dir;
}

function writeHistory(projectDir: string, entries: unknown[]): void {
  const dir = join(projectDir, ".lookout", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("what lookout has changed about itself", () => {
  test("a project that has never improved anything still reports its skills", async () => {
    tmpHome();
    const resolved = tmpProject();
    const l = await buildLearning(resolved);

    // The shipped skills are the baseline: they exist before any amendment does,
    // and a page that showed nothing here would be saying lookout has no
    // instructions rather than that it has not changed them.
    expect(l.instructions.skills.length).toBeGreaterThan(0);
    expect(l.instructions.skills.every((s) => s.amendmentPath === null)).toBe(true);
    expect(l.instructions.skills.every((s) => s.proposalPath === null)).toBe(true);
    expect(l.instructions.history).toEqual([]);
    expect(l.instructions.frozen).toBeNull();
    expect(l.running).toEqual({ improve: false, heal: false });
    expect(l.code.incidents).toEqual([]);
    expect(l.code.attempts).toEqual([]);
  });

  test("history comes back newest first, and a broken line does not lose the rest", async () => {
    tmpHome();
    const resolved = tmpProject();
    const dir = join(resolved.projectDir, ".lookout", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "history.jsonl"),
      [
        JSON.stringify({ at: "2026-01-01T00:00:00.000Z", skill: "visual-judge", action: "applied", summary: "first" }),
        "{ not json",
        JSON.stringify({ at: "2026-01-02T00:00:00.000Z", skill: "visual-judge", action: "rolled-back", summary: "second" }),
      ].join("\n") + "\n",
    );

    const l = await buildLearning(resolved);
    expect(l.instructions.history.map((h) => h.summary)).toEqual(["second", "first"]);
  });

  test("a proposal waiting to be read is reported against its skill", async () => {
    tmpHome();
    const resolved = tmpProject();
    const dir = join(resolved.projectDir, ".lookout", "skills", "design-placement");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PROPOSED.md"), "## an amendment nothing could grade\n");

    const l = await buildLearning(resolved);
    const placement = l.instructions.skills.find((s) => s.name === "design-placement");
    expect(placement?.proposalPath).toBe(join(dir, "PROPOSED.md"));
    expect(learningBadge(l).proposed).toBe(1);
  });

  test("a held improve lock is what says lookout is learning right now", async () => {
    tmpHome();
    const resolved = tmpProject();
    const lock = improveLockPath(resolved);
    mkdirSync(join(resolved.projectDir, ".lookout", "skills"), { recursive: true });
    writeFileSync(lock, new Date().toISOString());

    const l = await buildLearning(resolved);
    expect(l.running.improve).toBe(true);
    expect(learningBadge(l).running).toBe(true);
  });

  test("recurring failures are folded together, newest occurrence kept", async () => {
    const home = tmpHome();
    writeFileSync(
      join(home, "incidents.jsonl"),
      [
        { at: "2026-01-01T00:00:00.000Z", kind: "judge-unparseable", message: "the reply at line 12 was not json", verb: "check" },
        { at: "2026-01-02T00:00:00.000Z", kind: "judge-unparseable", message: "the reply at line 88 was not json", verb: "check" },
        { at: "2026-01-03T00:00:00.000Z", kind: "crash", message: "boom", verb: "capture" },
      ]
        .map((i) => JSON.stringify(i))
        .join("\n") + "\n",
    );

    const l = await buildLearning(tmpProject());
    // Line numbers differ between occurrences of one bug; the shape does not.
    expect(l.code.incidents[0]!.count).toBe(2);
    expect(l.code.incidents[0]!.kind).toBe("judge-unparseable");
    expect(l.code.incidents[0]!.latestAt).toBe("2026-01-02T00:00:00.000Z");
    expect(learningBadge(l).incidents).toBe(3);
  });

  test("a reverted heal carries the gates that killed it and a readable time", async () => {
    const home = tmpHome();
    const dir = join(home, "self-heal", "2026-08-30T17-43-31-016Z");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), JSON.stringify({ summary: "retry the judge", cause: "one retry is not enough" }));
    writeFileSync(
      join(dir, "gates.txt"),
      "=== typecheck (pass): bun run typecheck\nok\n\n=== lint (FAIL): bun run lint\nnope\n\n=== test (FAIL): bun test\nalso nope\n",
    );

    const l = await buildLearning(tmpProject());
    expect(l.code.attempts).toHaveLength(1);
    const attempt = l.code.attempts[0]!;
    expect(attempt.summary).toBe("retry the judge");
    expect(attempt.failedGates).toEqual(["lint", "test"]);
    // The directory name is a timestamp a filesystem would take; the page needs
    // the one a reader would.
    expect(attempt.at).toBe("2026-08-30T17:43:31.016Z");
    expect(Number.isNaN(Date.parse(attempt.at))).toBe(false);
  });

  test("an attempt with no readable report is still an attempt", async () => {
    const home = tmpHome();
    const dir = join(home, "self-heal", "2026-08-30T17-43-31-016Z");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "attempt.diff"), "diff --git a b\n");

    const l = await buildLearning(tmpProject());
    expect(l.code.attempts).toHaveLength(1);
    expect(l.code.attempts[0]!.summary).toBeNull();
    expect(l.code.attempts[0]!.failedGates).toEqual([]);
  });

  test("the cache key moves when the record does", async () => {
    tmpHome();
    const resolved = tmpProject();
    const before = learningKey(resolved);
    writeHistory(resolved.projectDir, [
      { at: "2026-01-01T00:00:00.000Z", skill: "visual-judge", action: "applied", summary: "x" },
    ]);
    expect(learningKey(resolved)).not.toBe(before);
  });
});
