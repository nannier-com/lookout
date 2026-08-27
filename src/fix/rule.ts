/**
 * The verdict rule, kept pure so it can be argued with in a test rather than
 * only in production.
 *
 * The judge is not deterministic: re-judging identical pixels can surface a
 * finding it did not mention before, and drop one it did. Pixel hashes ARE
 * deterministic. So every decision here turns on whether the evidence actually
 * moved, not on how the judge phrased itself today.
 *
 * It rules on ONE question: is this issue's own defect gone. A fix that clears
 * the defect and causes a different one somewhere else is not a failure of this
 * issue, and used to be recorded as one: the verdict came back `regressed`, the
 * findings stayed open, and every member burned an attempt, so two rounds of it
 * blocked an issue whose defect had actually been fixed, with a reason claiming
 * the defect persisted. A new defect is a new issue, filed with its own number
 * and its own evidence, and `verify-fix` reports it rather than charging it to
 * the issue it was asked about.
 */
export type Verdict = "passed" | "still-open" | "blocked";

export interface RuleInput {
  /** Attempt number this ruling covers, 1-based. */
  attempt: number;
  maxAttempts: number;
  /** Screenshots in scope whose pixels differ from the previous run. */
  changedShots: number;
  /** Findings still filed against this issue. */
  stillOpen: number;
}

export function ruleVerdict(i: RuleInput): Verdict {
  const exhausted = i.attempt >= i.maxAttempts;

  // Nothing may pass on unchanged pixels. If no screenshot moved, no edit
  // reached the rendered output, so an issue whose findings happen to be
  // absent this time was not fixed: it was judged differently. Passing here
  // would let judge variance alone close real defects, which is the one failure
  // an oracle must not have.
  if (i.changedShots === 0) return exhausted ? "blocked" : "still-open";

  if (i.stillOpen === 0) return "passed";
  return exhausted ? "blocked" : "still-open";
}
