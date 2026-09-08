// Nothing a second judge says is trusted.
//
// A challenger can mark real defects contested, so the ways its reply can be
// wrong matter more than the ways it can be right. Every malformed row here has
// to end the same way: treated as absent, leaving the first judge's finding
// standing. Never as a dispute, because a mangled reply must not be able to
// cast doubt on work somebody has to act on.
import { describe, expect, test } from "bun:test";
import { consensusFor, ingestChallenge, numberFindings } from "../src/judge/challenge.js";
import type { AiFinding } from "../src/judge/engine.js";
import type { ShotRecord } from "../src/types.js";

const SHOT = {
  id: "web/app/root/rest/desktop/dark",
  target: "app",
  route: "/",
  state: "rest",
  formFactor: "desktop",
  scheme: "dark",
  file: "a.png",
} as unknown as ShotRecord;

const LANE = { name: "judge-geometry", categories: ["spacing", "alignment"] as const };

function finding(over: Partial<AiFinding> = {}): AiFinding {
  return {
    shotId: SHOT.id,
    category: "spacing",
    attribute: "label-gap",
    region: "content",
    severity: "high",
    title: "t",
    problem: "p",
    expected: "e",
    observed: "o",
    confidence: "high",
    acceptance: [],
    ...over,
  } as AiFinding;
}

const ARGS = { count: 2, shots: [SHOT], project: "p", panel: LANE };

describe("ruling on findings by number", () => {
  test("agree, dispute and amend are taken", () => {
    const r = ingestChallenge(
      { verdicts: [
        { index: 0, verdict: "agree" },
        { index: 1, verdict: "dispute", note: "the gap is even on this shot" },
      ] },
      ARGS,
    );
    expect(r.verdicts).toEqual([
      { index: 0, verdict: "agree" },
      { index: 1, verdict: "dispute", note: "the gap is even on this shot" },
    ]);
    expect(r.rejected).toEqual([]);
  });

  test("a dispute with no account is not a dispute", () => {
    // The one answer that changes what a person sees is the one that has to be
    // argued. Without a note the finding stands unchallenged.
    const r = ingestChallenge({ verdicts: [{ index: 0, verdict: "dispute" }] }, ARGS);
    expect(r.verdicts).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  test("an index pointing at no finding is rejected, not applied to some other one", () => {
    const r = ingestChallenge({ verdicts: [{ index: 7, verdict: "dispute", note: "n" }] }, ARGS);
    expect(r.verdicts).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  test("an unknown verdict word is rejected rather than guessed at", () => {
    const r = ingestChallenge({ verdicts: [{ index: 0, verdict: "refuted", note: "n" }] }, ARGS);
    expect(r.verdicts).toEqual([]);
  });

  test("a second verdict for one finding does not overwrite the first", () => {
    const r = ingestChallenge(
      { verdicts: [
        { index: 0, verdict: "agree" },
        { index: 0, verdict: "dispute", note: "changed my mind" },
      ] },
      ARGS,
    );
    expect(r.verdicts).toEqual([{ index: 0, verdict: "agree" }]);
    expect(r.rejected).toHaveLength(1);
  });

  test("a reply with nothing usable in it leaves every finding standing", () => {
    const r = ingestChallenge({ verdicts: "not a list" }, ARGS);
    expect(r.verdicts).toEqual([]);
    expect(r.additions).toEqual([]);
  });
});

describe("what the challenger adds", () => {
  test("additions are held to the same contract as any finding", () => {
    const r = ingestChallenge(
      { verdicts: [], additions: [finding({ attribute: "row-gap" })] },
      { ...ARGS, count: 0 },
    );
    expect(r.additions).toHaveLength(1);
    expect(r.additions[0]!.attribute).toBe("row-gap");
  });

  test("and an addition outside the panel's lane is rejected there, as any would be", () => {
    // Reusing the ordinary ingestion is the point: the challenger gets no
    // license a first judge does not have.
    const r = ingestChallenge(
      { verdicts: [], additions: [finding({ category: "contrast" })] },
      { ...ARGS, count: 0 },
    );
    expect(r.additions).toEqual([]);
    expect(r.rejected.length).toBeGreaterThan(0);
  });
});

describe("what the two judges concluded", () => {
  test("agreement records the challenger as vouching", () => {
    const c = consensusFor("claude-code", "codex", { index: 0, verdict: "agree" }, 1);
    expect(c).toEqual({ reportedBy: "claude-code", agreedBy: ["codex"], rounds: 1 });
  });

  test("a dispute keeps both accounts", () => {
    const c = consensusFor("claude-code", "codex", { index: 0, verdict: "dispute", note: "not there" }, 1);
    expect(c.disputedBy).toEqual([{ oracle: "codex", note: "not there" }]);
    expect(c.agreedBy).toBeUndefined();
  });

  test("an amendment is agreement with a caveat, and never moves severity", () => {
    // The severity a queue sorts by must not depend on which AI spoke last.
    const c = consensusFor("claude-code", "codex", { index: 0, verdict: "amend", note: "more like medium" }, 1);
    expect(c.agreedBy).toEqual(["codex"]);
    expect(c.disputedBy).toBeUndefined();
  });

  test("silence is not agreement", () => {
    const c = consensusFor("claude-code", "codex", undefined, 1);
    expect(c).toEqual({ reportedBy: "claude-code", rounds: 1 });
    expect(c.agreedBy).toBeUndefined();
  });
});

describe("the findings put to the challenger", () => {
  test("are numbered, and carry the identity it must not change", () => {
    const text = numberFindings([finding(), finding({ attribute: "row-gap" })]);
    expect(text).toContain("#0 [high] spacing/label-gap");
    expect(text).toContain("#1 [high] spacing/row-gap");
  });
});
