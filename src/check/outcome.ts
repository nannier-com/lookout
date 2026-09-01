/**
 * What a check leaves behind: the ledger, and the report.
 *
 * Only groups lookout can actually vouch for are recorded. A group whose batch
 * failed, or whose reply left a member in neither the findings nor the clean
 * list, has no verdict, and writing "clean" for it would turn silence into a
 * durable clean bill of health. Left out, it is simply judged again next run.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { groupShots } from "../judge/engine.js";
import { groupHash, pruneLedger, recordVerdicts, saveLedger } from "../judge/ledger.js";
import type { VerifiedFinding } from "../judge/verify.js";
import { LookoutError, type ResolvedConfig, type ShotRecord } from "../types.js";
import { runId } from "../util.js";
import { workKey, type JudgePass } from "./batches.js";
import type { JudgePlan } from "./plan.js";
import type { CheckScope } from "./scope.js";

export interface CheckOutcome {
  runId: string;
  model: string;
  rubricVersion: number;
  /** The judge panels in scope this run, so "not asked" never reads as "not re-found". */
  panels: string[];
  shotsConsidered: number;
  judged: number;
  cached: number;
  findings: (VerifiedFinding & { cached?: boolean })[];
  refuted: { title: string; shotId: string; verifierNote: string }[];
  rejected: number;
  /**
   * Shots this run could not vouch for: a panel call that failed, or a reply
   * that left them out of both findings and cleanShotIds. They are not cached
   * whole, and they are not clean; some panel did not rule on them.
   */
  unjudged: number;
  /** Panel calls whose judge subprocess failed. The run continued without them. */
  failedBatches: { panel: string; shots: number; message: string }[];
  deterministicErrors: number;
  costUsd: number;
  reportPath: string;
  /**
   * Labelled composite of everything judged, defect-carrying tiles marked. The
   * calling session sees what lookout saw for the cost of one Read, instead of
   * spending more context on a dozen full-resolution screenshots than on the
   * findings themselves.
   */
  contactSheet?: string | null;
}

export interface RunCheckOptions {
  /** Called once the cache partition is known, before any judging begins. */
  onStart?: (toJudge: ShotRecord[]) => Promise<void>;
  /**
   * Invoked after each batch is judged AND verified, in order, never
   * concurrently. Findings are narrated to the event log as they land, so the
   * UI shows them while the rest of the app is still being judged.
   */
  onBatch?: (e: {
    index: number;
    total: number;
    shots: ShotRecord[];
    findings: VerifiedFinding[];
    shotsById: Map<string, ShotRecord>;
  }) => Promise<void>;
}

export async function recordOutcome(args: {
  resolved: ResolvedConfig;
  scope: CheckScope;
  plan: JudgePlan;
  pass: JudgePass;
  log: (line: string) => void;
  /** True when no --targets/--routes narrowed the run: the one moment every live group is visible. */
  fullScope?: boolean;
}): Promise<CheckOutcome> {
  const { resolved, scope, plan, pass, log } = args;
  const evDir = evidenceDir(resolved);
  // 6. Ledger: judged shots record their post-verification findings.
  //
  // Only groups lookout can actually vouch for. A group whose batch failed, or
  // whose reply left a member in neither findings nor cleanShotIds, has no
  // verdict, and writing "clean" for it would turn silence into a durable clean
  // bill of health. Left out, it is simply judged again next run.
  const checkRunId = runId("check");
  for (const item of plan.toJudge) {
    if (pass.uncacheable.has(workKey(item))) continue;
    const ids = new Set(item.shots.map((s) => s.id));
    // Each panel's entry holds only the findings its lane owns: the category
    // partition is disjoint, so the filter is exact, and a cache hit on one
    // panel can never serve a sibling's findings.
    const findings = pass.confirmed.filter(
      (f) =>
        ids.has(f.shotId) &&
        (item.panel.def.categories as readonly string[]).includes(f.category),
    );
    recordVerdicts(plan.ledger, checkRunId, item.identity, [{ shots: item.shots, findings }]);
  }
  if (args.fullScope) {
    const live = new Set([...groupShots(scope.shots).values()].map((g) => groupHash(g)));
    const dropped = pruneLedger(plan.ledger, live);
    if (dropped > 0) log(`ledger: pruned ${dropped} unreachable cached verdict(s)`);
  }
  await saveLedger(resolved, plan.ledger);

  if (pass.failedBatches.length > 0) {
    log(
      `${pass.failedBatches.length} panel call(s) failed and were not cached; ` +
        "the shots they cover are judged again next run",
    );
  }
  // Every panel call failing is a run that judged nothing, which must not read
  // as a clean result. One failing among several is reported and survived.
  if (pass.failedBatches.length > 0 && pass.failedBatches.length === pass.batchCount) {
    throw new LookoutError(
      `every judge batch failed (${pass.batchCount})`,
      pass.failedBatches[0]!.message,
    );
  }

  const allFindings = [...pass.confirmed, ...plan.cachedFindings];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  allFindings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const deterministicErrors = scope.shots
    .flatMap((s) => s.deterministicFindings)
    .filter((f) => f.severity === "error").length;

  // A shot is unjudged when ANY of its panels could not vouch for it: the
  // group's other panels may have cached, but the view as a whole was not
  // fully ruled on this run.
  const unjudgedIds = new Set<string>();
  for (const item of plan.toJudge) {
    if (!pass.uncacheable.has(workKey(item))) continue;
    for (const s of item.shots) unjudgedIds.add(s.id);
  }

  const reportPath = join(evDir, "judge-report.json");
  const outcome: CheckOutcome = {
    runId: checkRunId,
    model: plan.model,
    rubricVersion: Math.max(0, ...plan.panels.map((p) => p.version)),
    panels: plan.panels.map((p) => p.def.name),
    shotsConsidered: scope.shots.length,
    judged: plan.toJudgeShots.length,
    cached: plan.cached,
    findings: allFindings,
    refuted: pass.refuted.map((r) => ({ title: r.title, shotId: r.shotId, verifierNote: r.verifierNote })),
    rejected: pass.rejected,
    unjudged: unjudgedIds.size,
    failedBatches: pass.failedBatches,
    deterministicErrors,
    costUsd: Number(pass.costUsd.toFixed(4)),
    reportPath,
  };
  await writeFile(reportPath, JSON.stringify(outcome, null, 2));
  return outcome;
}
