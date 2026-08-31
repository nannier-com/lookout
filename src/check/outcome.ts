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
import type { JudgePass } from "./batches.js";
import type { JudgePlan } from "./plan.js";
import type { CheckScope } from "./scope.js";

export interface CheckOutcome {
  runId: string;
  model: string;
  rubricVersion: number;
  shotsConsidered: number;
  judged: number;
  cached: number;
  findings: (VerifiedFinding & { cached?: boolean })[];
  refuted: { title: string; shotId: string; verifierNote: string }[];
  rejected: number;
  /**
   * Shots this run could not vouch for: a batch that failed, or a reply that
   * left them out of both findings and cleanShotIds. They are not cached, and
   * they are not clean; they were not judged.
   */
  unjudged: number;
  /** Batches whose judge call failed. The run continued without them. */
  failedBatches: { shots: number; message: string }[];
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
  const judgedGroups = [...groupShots(plan.toJudge).values()]
    .filter((members) => !members.some((s) => pass.uncacheable.has(s.id)))
    .map((members) => {
      const ids = new Set(members.map((s) => s.id));
      return { shots: members, findings: pass.confirmed.filter((f) => ids.has(f.shotId)) };
    });
  recordVerdicts(plan.ledger, checkRunId, plan.identity, judgedGroups);
  if (args.fullScope) {
    const live = new Set([...groupShots(scope.shots).values()].map((g) => groupHash(g)));
    const dropped = pruneLedger(plan.ledger, live);
    if (dropped > 0) log(`ledger: pruned ${dropped} unreachable cached verdict(s)`);
  }
  await saveLedger(resolved, plan.ledger);

  if (pass.failedBatches.length > 0) {
    log(
      `${pass.failedBatches.length} batch(es) failed and were not cached; ` +
        "the shots they cover are judged again next run",
    );
  }
  // Every batch failing is a run that judged nothing, which must not read as a
  // clean result. One failing among several is reported and survived.
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

  const reportPath = join(evDir, "judge-report.json");
  const outcome: CheckOutcome = {
    runId: checkRunId,
    model: plan.model,
    rubricVersion: plan.rubric.version,
    shotsConsidered: scope.shots.length,
    judged: plan.toJudge.length,
    cached: plan.cached,
    findings: allFindings,
    refuted: pass.refuted.map((r) => ({ title: r.title, shotId: r.shotId, verifierNote: r.verifierNote })),
    rejected: pass.rejected,
    unjudged: pass.uncacheable.size,
    failedBatches: pass.failedBatches,
    deterministicErrors,
    costUsd: Number(pass.costUsd.toFixed(4)),
    reportPath,
  };
  await writeFile(reportPath, JSON.stringify(outcome, null, 2));
  return outcome;
}
