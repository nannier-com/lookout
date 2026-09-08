// Two AIs judging one screen must produce one defect, not two.
//
// Everything about the dialogue rests on that, so the load-bearing test here is
// the negative one: what the AIs said about a finding may never reach its
// identity. If consensus ever entered the fingerprint or the cluster key, one
// defect would split the moment a second AI agreed with the first, which is the
// exact failure two-AI judging exists to avoid.
import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "../src/backlog/fingerprint.js";
import { clusterKeyOf } from "../src/fix/cluster.js";
import { corroboration, isDisputed, oraclesOf, type FindingConsensus } from "../src/backlog/consensus.js";
import { mergeFindings } from "../src/backlog/merge.js";
import type { Backlog } from "../src/backlog/lib.js";

const AXES = {
  target: "app",
  route: "/settings",
  state: "rest",
  formFactor: "desktop" as const,
  scheme: "dark" as const,
  category: "contrast" as const,
  attribute: "label-gap",
  channel: "ai" as const,
};

const AGREED: FindingConsensus = { reportedBy: "claude-code", agreedBy: ["codex"], rounds: 1 };
const DISPUTED: FindingConsensus = {
  reportedBy: "claude-code",
  disputedBy: [{ oracle: "codex", note: "the ratio passes on this shot" }],
  rounds: 2,
};

describe("what the AIs said never becomes what the finding is", () => {
  test("the fingerprint is byte-identical with and without a dialogue", () => {
    const bare = fingerprintOf(AXES);
    expect(fingerprintOf({ ...AXES, consensus: AGREED } as never)).toBe(bare);
    expect(fingerprintOf({ ...AXES, consensus: DISPUTED } as never)).toBe(bare);
  });

  test("and so is the cluster key, which mints the issue id", () => {
    const bare = clusterKeyOf(AXES);
    expect(clusterKeyOf({ ...AXES, consensus: AGREED } as never)).toBe(bare);
    expect(clusterKeyOf({ ...AXES, consensus: DISPUTED } as never)).toBe(bare);
  });

  test("two AIs agreeing is one identity, not two", () => {
    // The whole point: the same defect, seen by both, is one row in the backlog.
    expect(fingerprintOf({ ...AXES, consensus: AGREED } as never)).toBe(
      fingerprintOf({ ...AXES, consensus: { reportedBy: "codex", agreedBy: ["claude-code"] } } as never),
    );
  });
});

describe("reading a dialogue", () => {
  test("a dispute is visible without being a status", () => {
    expect(isDisputed({ consensus: DISPUTED })).toBe(true);
    expect(isDisputed({ consensus: AGREED })).toBe(false);
  });

  test("a record nothing was ever asked about reads as unknown, not as disputed", () => {
    // Absence is not an answer. A finding filed when one AI judged must not be
    // rendered as though a second had looked and stayed silent.
    expect(isDisputed({})).toBe(false);
    expect(corroboration({})).toBe(1);
  });

  test("corroboration counts the AIs that vouch, the reporter included", () => {
    expect(corroboration({ consensus: AGREED })).toBe(2);
    expect(corroboration({ consensus: DISPUTED })).toBe(1);
  });

  test("every AI with an opinion can be named, without repeats", () => {
    expect(oraclesOf(AGREED)).toEqual(["claude-code", "codex"]);
    expect(oraclesOf(DISPUTED)).toEqual(["claude-code", "codex"]);
  });
});

describe("a dialogue survives the next sighting", () => {
  test("refreshed when the new run held one, and never cleared when it did not", () => {
    const base = {
      ...AXES,
      fingerprint: fingerprintOf(AXES),
      severity: "high" as const,
      title: "t",
      problem: "p",
      expected: "e",
      observed: "o",
      confidence: "high" as const,
      verified: true,
      evidence: [],
    };
    const backlog: Backlog = { note: "", project: "p", updatedAt: "", findings: {}, issues: {} };
    mergeFindings(backlog, [{ ...base, consensus: DISPUTED }] as never, "r1", "now");
    expect(backlog.findings[base.fingerprint]!.consensus).toEqual(DISPUTED);

    // A run with no challenger carries no dialogue. It must not erase the one
    // already recorded: silence is not agreement.
    mergeFindings(backlog, [base] as never, "r2", "now");
    expect(backlog.findings[base.fingerprint]!.consensus).toEqual(DISPUTED);

    // A run that did hold one replaces it whole, so an AI that agreed once
    // cannot go on vouching for a finding it later disputed.
    mergeFindings(backlog, [{ ...base, consensus: AGREED }] as never, "r3", "now");
    expect(backlog.findings[base.fingerprint]!.consensus).toEqual(AGREED);
  });

  test("and a dispute changes no status", () => {
    // Disputed is a caveat on open work, never an adjudication. Letting one AI
    // close another's finding would hand a single vendor a veto.
    const backlog: Backlog = { note: "", project: "p", updatedAt: "", findings: {}, issues: {} };
    const fp = fingerprintOf(AXES);
    mergeFindings(backlog, [{
      ...AXES, fingerprint: fp, severity: "high", title: "t", problem: "p", expected: "e",
      observed: "o", confidence: "high", verified: true, evidence: [], consensus: DISPUTED,
    }] as never, "r1", "now");
    expect(backlog.findings[fp]!.status).toBe("open");
  });
});
