/**
 * Judging the frozen set with the skills exactly as they stand.
 *
 * This is the gate, and it runs the real pipeline rather than a simplified one:
 * the judge files, then the adversarial refuter gets to kill findings before
 * anything is counted, once per view-group batch exactly as `check` runs it
 * (src/check/batches.ts), because an amendment to either skill has to be graded
 * in the context shape and index space it will actually run in.
 *
 * One deliberate divergence from `check`: the judge is NOT shown the "ALREADY
 * FILED" aid that production builds from the live backlog (src/check/plan.ts).
 * That aid exists to keep the judge's freehand `attribute` stable, and the gate
 * ignores the attribute on purpose, deciding a claim at its panel's granularity
 * instead (src/skills/verdict.ts). Rebuilding the aid from the frozen claims would
 * hand the judge the answer key: every must-file claim would appear as an
 * already-open defect the aid instructs the judge to re-file by name, so an
 * amendment that blinded the judge could still pass the "lost" check by
 * parroting the list. Each frozen claim was first filed by a judge that had no
 * such aid; the replay holds every candidate to the same conditions.
 */
import { batchShots, judgeBatch, type AiFinding } from "../judge/engine.js";
import { PANELS } from "../judge/panels.js";
import { loadJudges } from "../judge/rubric.js";
import { verifyFindings } from "../judge/verify.js";
import { declaredBlock } from "../judge/direction.js";
import { loadSkill } from "./load.js";
import { viewGroupId } from "../judge/grouping.js";
import {
  casesAsShots,
  regressionDir,
  usableCases,
  type RegressionCase,
  type RegressionSet,
} from "./regression.js";
import { evaluateReplay, type Drift, type Violation } from "./verdict.js";
import { LookoutError, type ResolvedConfig } from "../types.js";

/**
 * The skills the frozen set can actually exercise. An amendment to anything
 * else is written down as a proposal rather than applied: auto-applying a
 * change nothing can grade is the exact thing the gate exists to prevent.
 */
export const GATED_SKILLS = new Set([
  "judge-core",
  "judge-integrity",
  "judge-geometry",
  "judge-visibility",
  "judge-text",
  "judge-craft",
  "judge-taste",
  "refute-finding",
]);

// judge-design-parity is deliberately NOT gated: the frozen set carries no
// design references, so no frozen case can exercise a design-parity verdict,
// and an amendment nothing can grade lands as a proposal for a person to
// read, the same treatment design-placement gets below.

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
//
// plan-navigation is not gated for the same structural reason: its output is
// a plan of clicks against a live page, and no frozen screenshot can grade
// whether a different curation of affordances would have been better.


export interface ReplayScope {
  /**
   * The skill the candidate amendment touched. A panel amendment changed only
   * that panel's prompt, so only that panel replays: every other judge's
   * bytes, and therefore its verdicts, are identical to the run that settled
   * the claims. An amendment to the core or the refuter changes every
   * prompt, so every claim-owning panel replays.
   */
  amendedSkill?: string;
  /**
   * Re-judge only the view groups these shots belong to.
   *
   * A confirmation round re-tests what failed rather than the whole set, and a
   * control round re-tests it with the candidate withdrawn. The unit is the view
   * GROUP and not the shot because the rubric compares within a group, so
   * dropping a shot's siblings would change the question being asked.
   */
  onlyShots?: ReadonlySet<string>;
}

/** The cases to judge: every one, or the whole view group of each named shot. */
function narrow(cases: RegressionCase[], onlyShots?: ReadonlySet<string>): RegressionCase[] {
  if (!onlyShots) return cases;
  const groups = new Set(cases.filter((c) => onlyShots.has(c.shotId)).map(viewGroupId));
  return cases.filter((c) => groups.has(viewGroupId(c)));
}

export async function replayRegression(
  resolved: ResolvedConfig,
  set: RegressionSet,
  model: string,
  scope: ReplayScope = {},
): Promise<{ violations: Violation[]; drift: Drift[]; findings: AiFinding[]; costUsd: number }> {
  const usable = { ...set, cases: narrow(usableCases(resolved, set), scope.onlyShots) };
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
  const refute = await loadSkill(resolved, "refute-finding");

  // The panels that own at least one frozen claim. An unclaimed panel's
  // silence is ungradeable, and post-lane-enforcement no other panel can file
  // (or re-file) a category it does not own, so a claim's category names the
  // only panel whose behavior can move its verdict. design-parity never
  // replays: frozen cases carry no design reference for it to judge against.
  const claimed = new Set(
    usable.cases.flatMap((c) => [...c.mustFile, ...c.mustNotFile].map((cl) => cl.category)),
  );
  const claimOwning = (await loadJudges(resolved)).filter(
    (j) => !j.def.designOnly && j.def.categories.some((c) => claimed.has(c)),
  );
  const isPanel = PANELS.some((p) => p.name === scope.amendedSkill);
  const active = isPanel
    ? claimOwning.filter((j) => j.def.name === scope.amendedSkill)
    : claimOwning;
  if (isPanel && active.length === 0) {
    throw new LookoutError(
      `the frozen set holds no claims in ${scope.amendedSkill}'s categories, so nothing can grade it`,
      "settle a verdict in its lane and run `lookout skills freeze`",
    );
  }

  let costUsd = 0;
  const shotsById = new Map(shots.map((s) => [s.id, s]));
  const findings: AiFinding[] = [];
  for (const batch of batchShots(shots)) {
    const fresh: AiFinding[] = [];
    for (const judge of active) {
      const res = await judgeBatch(judge.text, resolved.project, batch, dir, model, {
        projectDir: resolved.projectDir,
        handoff: judge.handoff,
        panel: {
          name: judge.def.name,
          categories: judge.def.categories,
          ...(judge.def.ariaEvidence ? { aria: true } : {}),
        },
      });
      costUsd += res.costUsd ?? 0;
      fresh.push(...res.findings);
    }
    if (fresh.length === 0) continue;
    // The pipeline as it actually runs: every panel judges the batch, then one
    // pooled refuter call holds the batch's whole union, so an amendment to
    // refute-finding is graded against the same context window production
    // gives it. Unlike production there is no catch here: a refuter that
    // cannot run means the gate cannot grade, and amend.ts answers that by
    // rolling the candidate back rather than counting unrefuted findings as a
    // verdict.
    const verified = await verifyFindings(
      refute.text, fresh, shotsById, dir, model, resolved.projectDir,
      declaredBlock(resolved.config.neverFile, null),
    );
    costUsd += verified.costUsd ?? 0;
    findings.push(...verified.confirmed);
  }

  // mustFile claims are graded only for the panels that ran: an inactive
  // panel's prompt is byte-identical to the run that settled its claims, so
  // its silence here proves nothing and must not read as "lost". That also
  // retires frozen design-parity claims, which no replay can satisfy (the
  // cases carry no design reference). mustNotFile claims stay whole: the lane
  // rule means only a claim's owner can re-file it, and if a panel somehow
  // filed out of lane anyway, suppressing the violation would hide two bugs.
  const activeCats = new Set(active.flatMap((j) => j.def.categories as readonly string[]));
  const graded = {
    ...usable,
    cases: usable.cases.map((c) => ({
      ...c,
      mustFile: c.mustFile.filter((cl) => activeCats.has(cl.category)),
    })),
  };
  return { ...evaluateReplay(graded, findings), findings, costUsd };
}
