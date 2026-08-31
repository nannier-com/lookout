/**
 * Judging the frozen set with the skills exactly as they stand.
 *
 * This is the gate, and it runs the real pipeline rather than a simplified one:
 * the judge files, then the adversarial refuter gets to kill findings before
 * anything is counted, because that is what happens in a real run and an
 * amendment to either of them has to be graded the same way.
 */
import { batchShots, judgeBatch, type AiFinding } from "../judge/engine.js";
import { loadRubric } from "../judge/rubric.js";
import { verifyFindings } from "../judge/verify.js";
import { loadSkill } from "./load.js";
import {
  casesAsShots,
  evaluateReplay,
  regressionDir,
  usableCases,
  type RegressionSet,
  type Violation,
} from "./regression.js";
import { LookoutError, type ResolvedConfig } from "../types.js";

/**
 * The skills the frozen set can actually exercise. An amendment to anything
 * else is written down as a proposal rather than applied: auto-applying a
 * change nothing can grade is the exact thing the gate exists to prevent.
 */
export const GATED_SKILLS = new Set(["visual-judge", "refute-finding"]);

// kit-conformance is not gated either, for the same reason and one more: what
// it reads is source, and the frozen set holds screenshots. An amendment to it
// is written down as a proposal.
//
// design-placement is deliberately NOT gated. The frozen set is screenshots
// replayed through the visual judge, and it cannot decide whether a fix belongs
// in a component or in its caller: that answer lives in source the frozen set
// does not contain. So an amendment to it is written down as a proposal for a
// person to read, which is what this file already does for everything the gate
// cannot grade.


export async function replayRegression(
  resolved: ResolvedConfig,
  set: RegressionSet,
  model: string,
): Promise<{ violations: Violation[]; findings: AiFinding[]; costUsd: number }> {
  const usable = { ...set, cases: usableCases(resolved, set) };
  if (usable.cases.length === 0) {
    throw new LookoutError(
      set.cases.length === 0
        ? "the frozen regression set is empty"
        : "the frozen screenshots are not on this machine",
      "run `lookout skills freeze` (the manifest is committed; the pixels are rebuilt from evidence)",
    );
  }
  const dir = regressionDir(resolved);
  const shots = casesAsShots(usable);
  const rubric = await loadRubric(resolved);
  const refute = await loadSkill(resolved, "refute-finding");

  let costUsd = 0;
  const raw: AiFinding[] = [];
  for (const batch of batchShots(shots)) {
    const res = await judgeBatch(rubric.text, resolved.project, batch, dir, model, {
      handoff: rubric.handoff,
    });
    costUsd += res.costUsd ?? 0;
    raw.push(...res.findings);
  }

  // The pipeline as it actually runs: the refuter gets to kill findings before
  // anything is filed, so an amendment to it is gated the same way.
  const shotsById = new Map(shots.map((s) => [s.id, s]));
  let findings = raw;
  if (raw.length > 0) {
    const verified = await verifyFindings(refute.text, raw, shotsById, dir, model);
    costUsd += verified.costUsd ?? 0;
    findings = verified.confirmed;
  }

  return { violations: evaluateReplay(usable, findings), findings, costUsd };
}
