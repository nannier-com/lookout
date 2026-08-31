/**
 * Ruling this issue's acceptance criteria against the fresh evidence.
 *
 * Each source is ruled by the thing that can actually decide it: the
 * deterministic checks rule their own, the pixel hashes rule the re-capture
 * guard, and the judge-authored ones get an independent look at the new
 * screenshots rather than being inferred from whether the original finding came
 * back. That inference was the bug this separation removes: a criterion about a
 * focus ring would have read as met because an unrelated contrast finding
 * cleared.
 *
 * A verifier that cannot run leaves its criteria unruled rather than failing
 * the issue. The primary gate is whether the defect is still there; an
 * unreachable criterion is not evidence of anything.
 */
import { evidenceDir } from "../config.js";
import { blocksPass, type AcceptanceCriterion } from "../issues/acceptance.js";
import {
  asCriteriaText,
  judgeableCriteria,
  matchJudged,
  ruleAcceptance,
  type JudgedCriterion,
} from "../issues/rule-acceptance.js";
import { MAX_VERIFY_SHOTS, verifyCriteria } from "../judge/criteria.js";
import { loadSkill } from "../skills/load.js";
import { emit } from "../report/events.js";
import type { deterministicToFindings } from "../backlog/lib.js";
import type { Backlog } from "../backlog/lib.js";
import type { FixCluster } from "../fix/cluster.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import { nowIso, str, type Parsed } from "../util.js";

export interface RuledAcceptance {
  /** Every criterion with its verdict, as written back to the record. */
  criteria: AcceptanceCriterion[];
  /** The ones that stand in the way of a pass. */
  unmet: AcceptanceCriterion[];
  costUsd: number;
}

export async function ruleIssueAcceptance(args: {
  resolved: ResolvedConfig;
  parsed: Parsed;
  backlog: Backlog;
  issueId: string;
  cluster: FixCluster;
  shotsById: Map<string, ShotRecord>;
  changedShots: Set<string>;
  baselineShots: number;
  /** Every deterministic finding this re-capture produced, whatever its cluster. */
  freshDeterministic: ReturnType<typeof deterministicToFindings>;
  runIdNow: string;
}): Promise<RuledAcceptance> {
  const {
    resolved,
    parsed,
    backlog,
    issueId,
    cluster,
    shotsById,
    changedShots,
    baselineShots,
    freshDeterministic,
    runIdNow,
  } = args;
  const record = backlog.issues?.[issueId];
  const criteria = record?.acceptance ?? [];
  const judgeable = judgeableCriteria(criteria);
  let judged = new Map<string, JudgedCriterion>();
  let acceptanceCost = 0;

  if (judgeable.length > 0) {
    // The issue's own views, capped: these criteria are about this defect, and
    // the verifier needs the whole evidence set in one context.
    const ownShotIds = new Set(
      cluster.members.flatMap((m) => m.evidence.map((e) => e.shotId)),
    );
    const forCriteria = [...shotsById.values()]
      .filter((sh) => ownShotIds.has(sh.id))
      .slice(0, MAX_VERIFY_SHOTS);
    const shotsForCriteria =
      forCriteria.length > 0 ? forCriteria : [...shotsById.values()].slice(0, MAX_VERIFY_SHOTS);
    try {
      const skill = await loadSkill(resolved, "verify-acceptance");
      const result = await verifyCriteria(
        skill.text,
        resolved.project,
        asCriteriaText(judgeable),
        shotsForCriteria,
        evidenceDir(resolved),
        str(parsed.flags.model) ?? "sonnet",
      );
      judged = matchJudged(judgeable, result.criteria);
      acceptanceCost = result.costUsd ?? 0;
    } catch (e) {
      // A verifier that could not run leaves those criteria unruled rather than
      // failing the issue: `stillOpen` is the primary gate, and an unreachable
      // criterion is not evidence of anything.
      emit("error", `acceptance criteria could not be ruled: ${(e as Error).message}`, {}, "error");
    }
  }

  const freshFingerprints = new Set(freshDeterministic.map((f) => f.fingerprint));
  const recapturedFingerprints = new Set(
    criteria
      .map((c) => c.from)
      .filter((fp): fp is string => !!fp)
      .filter((fp) =>
        (backlog.findings[fp]?.evidence ?? []).some((e) => shotsById.has(e.shotId)),
      ),
  );
  const ruledCriteria = ruleAcceptance({
    criteria,
    changedShots: changedShots.size,
    totalShots: shotsById.size,
    baselineShots,
    deterministic: { freshFingerprints, recapturedFingerprints },
    judged,
    ruledAt: nowIso(),
    runId: runIdNow,
  });
  if (record) record.acceptance = ruledCriteria;
  const unmet = blocksPass(ruledCriteria);

  return { criteria: ruledCriteria, unmet, costUsd: acceptanceCost };
}
