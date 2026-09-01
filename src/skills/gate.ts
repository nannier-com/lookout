/**
 * The gate: deciding whether a candidate amendment actually broke anything.
 *
 * A replay is a sample of a stochastic process. The judge is a model, and on
 * byte-identical pixels with byte-identical prompts it does not return
 * byte-identical verdicts. Measured on a 63-claim frozen set with the skills
 * COMPLETELY UNCHANGED, two replays lost 6 and 22 settled claims respectively.
 * Matching a claim at its panel's granularity (verdict.ts) removes the largest
 * single cause of that, but it cannot remove the rest, because the rest is not
 * a bug in the matcher: it is the judge declining to mention, this time, a defect
 * it mentioned last time.
 *
 * Comparing one sample against one settled verdict and rolling back on any
 * difference therefore rolls back everything, for ever, and reports it as "the
 * amendment broke settled verdicts". That is the silent failure this file
 * exists to end.
 *
 * The answer is not a tolerance. A threshold is a number nobody can justify
 * from evidence, and one large enough to absorb the noise is also large enough
 * to wave through an amendment that genuinely blinded a panel. The answer is
 * the one this codebase already applies to findings, where the adversarial
 * refuter has to confirm a defect before it counts:
 *
 *   REPRODUCE  a violation is re-judged, and only counts if it recurs every
 *              time. A one-off miss is noise and is discarded as noise.
 *   CONTROL    what survives is re-judged once more with the candidate
 *              WITHDRAWN. If the unchanged skills fail it too, the claim is
 *              stale and the amendment did not break it.
 *
 * Both rounds re-judge only the view groups that are in dispute, so a clean
 * replay costs exactly what it cost before and a disputed one costs a fraction
 * of a full pass. Zero tolerance survives intact: what changed is that a
 * violation now has to be evidence rather than a single sample.
 */
import { replayRegression } from "./replay.js";
import { violationKey, type Drift, type Violation } from "./verdict.js";
import type { RegressionSet } from "./regression.js";
import type { ResolvedConfig } from "../types.js";

/**
 * How many times a violation must reproduce before it is believed.
 *
 * Each round re-judges only what still fails, so the cost falls away as the
 * dispute narrows. Three is where a per-requirement miss rate around one in ten
 * stops being able to manufacture a violation on its own, and the control round
 * then has to agree that the unchanged skills still hold the ground.
 */
export const CONFIRM_ATTEMPTS = 3;

export interface GateOutcome {
  /** Reproduced under the candidate, and not reproduced without it. */
  violations: Violation[];
  /** Satisfied, but under a sibling category in the same lane. */
  drift: Drift[];
  /** Failed under the candidate AND with the candidate withdrawn. */
  stale: Violation[];
  /** Failed once and not again: the judge's own run-to-run spread. */
  unreproduced: Violation[];
  costUsd: number;
  /** How many replays the verdict took, control included. */
  rounds: number;
}

export interface GateOptions {
  amendedSkill: string;
  /**
   * Run something with the candidate withdrawn and put it back afterwards.
   *
   * The control needs the unchanged prompts on disk, and only the caller knows
   * how this project's skill layer is written and restored.
   */
  withoutCandidate: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** Merge drift records from several rounds, keeping one per claim. */
function mergeDrift(into: Map<string, Drift>, more: Drift[]): void {
  for (const d of more) into.set(`${d.shotId}|${d.panel}|${d.category}`, d);
}

export async function runGate(
  resolved: ResolvedConfig,
  set: RegressionSet,
  model: string,
  opts: GateOptions,
): Promise<GateOutcome> {
  const { amendedSkill, withoutCandidate } = opts;
  let costUsd = 0;
  let rounds = 0;
  const drift = new Map<string, Drift>();

  const first = await replayRegression(resolved, set, model, { amendedSkill });
  costUsd += first.costUsd;
  rounds++;
  mergeDrift(drift, first.drift);

  // Reproduce. Each round narrows to the view groups still in dispute, and a
  // violation that fails to recur is dropped: it was the judge's spread, not
  // the amendment's doing.
  let suspect = first.violations;
  const dropped = new Map<string, Violation>();
  while (suspect.length > 0 && rounds < CONFIRM_ATTEMPTS) {
    const again = await replayRegression(resolved, set, model, {
      amendedSkill,
      onlyShots: new Set(suspect.map((v) => v.shotId)),
    });
    costUsd += again.costUsd;
    rounds++;
    mergeDrift(drift, again.drift);
    const recurred = new Set(again.violations.map(violationKey));
    for (const v of suspect) if (!recurred.has(violationKey(v))) dropped.set(violationKey(v), v);
    suspect = suspect.filter((v) => recurred.has(violationKey(v)));
  }

  const unreproduced = [...dropped.values()];
  if (suspect.length === 0) {
    return { violations: [], drift: [...drift.values()], stale: [], unreproduced, costUsd, rounds };
  }

  // Control. Whatever survived is judged once more with the candidate
  // withdrawn: a claim the unchanged skills also fail is one the frozen set can
  // no longer settle, and rolling an amendment back for it would be blaming the
  // candidate for ground that was already lost.
  const control = await withoutCandidate(() =>
    replayRegression(resolved, set, model, {
      amendedSkill,
      onlyShots: new Set(suspect.map((v) => v.shotId)),
    }),
  );
  costUsd += control.costUsd;
  rounds++;
  const alsoWithout = new Set(control.violations.map(violationKey));

  return {
    violations: suspect.filter((v) => !alsoWithout.has(violationKey(v))),
    stale: suspect.filter((v) => alsoWithout.has(violationKey(v))),
    drift: [...drift.values()],
    unreproduced,
    costUsd,
    rounds,
  };
}
