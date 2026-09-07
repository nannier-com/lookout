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
import { DEFAULT_JUDGE_MODEL } from "../judge/engine.js";
import { loadSkill } from "../skills/load.js";
import { emit } from "../report/events.js";
import { recordIncident } from "../skills/incidents.js";
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
  /** How much of the scope the model verifier actually saw. */
  evidence: { used: number; total: number };
}

/**
 * The shots the criteria verifier sees when the cap bites, most refuting
 * first: (1) the issue's own evidence whose pixels changed this run, (2) its
 * own unchanged evidence, (3) the rest of the scope, changed first. Within a
 * tier, cover distinct formFactor x scheme pairs before spending slots on
 * duplicates, so "visible in dark" cannot be ruled met with every dark shot
 * cut. Exported for the tests; pure.
 */
export function rankVerifyShots(
  shots: ShotRecord[],
  ownShotIds: ReadonlySet<string>,
  changedShots: ReadonlySet<string>,
  cap: number,
): ShotRecord[] {
  const tierOf = (s: ShotRecord): number =>
    ownShotIds.has(s.id) ? (changedShots.has(s.id) ? 0 : 1) : changedShots.has(s.id) ? 2 : 3;
  const tiers: ShotRecord[][] = [[], [], [], []];
  for (const s of shots) tiers[tierOf(s)]!.push(s);

  const picked: ShotRecord[] = [];
  const covered = new Set<string>();
  for (const tier of tiers) {
    const later: ShotRecord[] = [];
    for (const s of tier) {
      const pair = `${s.formFactor}|${s.scheme}`;
      if (covered.has(pair)) later.push(s);
      else {
        covered.add(pair);
        picked.push(s);
      }
    }
    picked.push(...later);
  }
  return picked.slice(0, cap);
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
  let evidenceUsed = shotsById.size;

  if (judgeable.length > 0) {
    // The issue's own views first, capped and RANKED: these criteria are about
    // this defect, and when the cap bites, the shots most able to refute a
    // "met" (changed pixels, uncovered form-factor/scheme pairs) must survive
    // the cut. A plain slice took Map insertion order, which is capture order,
    // so a 24-shot cluster could rule a dark-scheme criterion met because
    // every dark shot fell past index 19, invisibly.
    const ownShotIds = new Set(
      cluster.members.flatMap((m) => m.evidence.map((e) => e.shotId)),
    );
    const shotsForCriteria = rankVerifyShots(
      [...shotsById.values()],
      ownShotIds,
      changedShots,
      MAX_VERIFY_SHOTS,
    );
    evidenceUsed = shotsForCriteria.length;
    if (shotsForCriteria.length < shotsById.size) {
      emit(
        "note",
        `acceptance ruled against ${shotsForCriteria.length} of ${shotsById.size} shot(s); ` +
          "changed evidence and uncovered form-factor/scheme pairs were kept first",
        { used: shotsForCriteria.length, total: shotsById.size },
      );
    }
    try {
      const skill = await loadSkill(resolved, "verify-acceptance");
      const result = await verifyCriteria(
        skill.text,
        resolved.project,
        asCriteriaText(judgeable),
        shotsForCriteria,
        evidenceDir(resolved),
        str(parsed.flags.model) ?? DEFAULT_JUDGE_MODEL,
      );
      judged = matchJudged(judgeable, result.criteria);
      acceptanceCost = result.costUsd ?? 0;
    } catch (e) {
      // A verifier that could not run leaves those criteria unruled rather
      // than failing the issue: `stillOpen` is the primary gate, and an
      // unreachable criterion is not evidence of anything. Durable, though:
      // the event log is truncated by the next capture, and a verifier that
      // keeps dying is exactly what the incident log exists to show.
      emit("error", `acceptance criteria could not be ruled: ${(e as Error).message}`, {}, "error");
      recordIncident({
        at: nowIso(),
        kind: "crash",
        verb: "verify-fix",
        message: `acceptance verifier failed: ${(e as Error).message.slice(0, 200)}`,
        project: resolved.projectDir,
      });
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

  return {
    criteria: ruledCriteria,
    unmet,
    costUsd: acceptanceCost,
    evidence: { used: evidenceUsed, total: shotsById.size },
  };
}

/**
 * Judge-authored criteria this run cannot vouch for: never ruled, or last
 * ruled by a different run. A pass may only rest on rulings earned against
 * THIS attempt's evidence; a stale "met" is a check that did not happen now.
 * The other sources are exempt because their rulings are recomputed
 * mechanically above on every call.
 */
export function unruledJudgeCriteria(
  criteria: AcceptanceCriterion[],
  runIdNow: string,
): AcceptanceCriterion[] {
  return judgeableCriteria(criteria).filter(
    (c) => c.verdict === "pending" || c.runId !== runIdNow,
  );
}
