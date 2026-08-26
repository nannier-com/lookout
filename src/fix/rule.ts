/**
 * The verdict rule, kept pure so it can be argued with in a test rather than
 * only in production.
 *
 * The judge is not deterministic: re-judging identical pixels can surface a
 * finding it did not mention before, and drop one it did. Pixel hashes ARE
 * deterministic. So every decision here turns on whether the evidence actually
 * moved, not on how the judge phrased itself today.
 */
export type Verdict = "passed" | "still-open" | "regressed" | "blocked";

export interface RuleInput {
  /** Attempt number this ruling covers, 1-based. */
  attempt: number;
  maxAttempts: number;
  /** Screenshots in scope whose pixels differ from the previous run. */
  changedShots: number;
  /** Findings still filed against this cluster. */
  stillOpen: number;
  /** New critical/high findings, already filtered to changed screenshots. */
  regressions: number;
}

export function ruleVerdict(i: RuleInput): Verdict {
  const exhausted = i.attempt >= i.maxAttempts;

  // Nothing may pass on unchanged pixels. If no screenshot moved, no edit
  // reached the rendered output, so a cluster whose findings happen to be
  // absent this time was not fixed: it was judged differently. Passing here
  // would let judge variance alone close real defects, which is the one failure
  // an oracle must not have.
  if (i.changedShots === 0) return exhausted ? "blocked" : "still-open";

  if (i.stillOpen === 0 && i.regressions === 0) return "passed";
  if (exhausted) return "blocked";
  if (i.regressions > 0) return "regressed";
  return "still-open";
}
