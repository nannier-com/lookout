/**
 * What a check leaves behind: the ledger, and the report.
 *
 * Only groups lookout can actually vouch for are recorded. A group whose batch
 * failed, or whose reply left a member in neither the findings nor the clean
 * list, has no verdict, and writing "clean" for it would turn silence into a
 * durable clean bill of health. Left out, it is simply judged again next run.
 *
 * The pieces are separate functions because a screen walk uses them one at a
 * time: it records each screen's verdicts to the ledger the moment they land
 * (a crash mid-walk must keep what was judged) and rewrites one cumulative
 * report after every screen. A plain check composes them in `recordOutcome`.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { groupShots } from "../judge/engine.js";
import { groupHash, pruneLedger, recordVerdicts, saveLedger } from "../judge/ledger.js";
import type { DroppedCriterion, RepairedFinding, VerifiedFinding } from "../judge/verify.js";
import type { ContractLapse } from "../judge/reply.js";
import { LookoutError, type ResolvedConfig, type ShotRecord } from "../types.js";
import { runId } from "../util.js";
import { workKey, type JudgePass } from "./batches.js";
import { tallyFormFactors, type FormFactorTally } from "./tally.js";
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
  refuted: { title: string; shotId: string; verifierNote: string; judge?: string }[];
  /** Confirmed findings whose plain sentence the refuter had to supply. */
  repaired: RepairedFinding[];
  /**
   * Acceptance criteria the refuter could not let stand, and why.
   *
   * A criterion no screenshot can settle blocks nothing in a verify-fix: it
   * comes back not-verifiable and quietly degrades the ruling to "the defect
   * was not re-filed". Caught at filing time it costs nothing, and the panel
   * that wrote it can be taught.
   */
  droppedCriteria: DroppedCriterion[];
  /** Findings filed with a problem written for one reader; `skills improve` reads these. */
  degraded: ContractLapse[];
  rejected: number;
  /**
   * Shots this run could not vouch for: a panel call that failed, or a reply
   * that left them out of both findings and cleanShotIds. They are not cached
   * whole, and they are not clean; some panel did not rule on them.
   */
  unjudged: number;
  /**
   * Which panel left which shots unruled, beside the count.
   *
   * `unjudged` says a verdict is missing; this says whose it was and about
   * what. A panel that keeps dropping the same kind of shot has instructions
   * that are not landing, and `skills improve` can only be taught that if the
   * run writes down more than a number.
   */
  unaccounted: { panel: string; groupId: string; shotIds: string[] }[];
  /** What this run judged, per platform and form factor; the phone shots are counted apart from the desktop ones. */
  formFactors: FormFactorTally[];
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

/**
 * Write this pass's verdicts into the plan's ledger (in memory; the caller
 * saves). Only groups lookout can vouch for: a (group, panel) pair whose call
 * failed or whose reply skipped a shot is left out, so it is judged again.
 */
export function recordLedger(plan: JudgePlan, pass: JudgePass, checkRunId: string): void {
  for (const item of plan.toJudge) {
    if (pass.uncacheable.has(workKey(item))) continue;
    const ids = new Set(item.shots.map((s) => s.id));
    // Each panel's entry holds only the findings its lane owns: the category
    // partition is disjoint, so the filter is exact, and a cache hit on one
    // panel can never serve a sibling's findings.
    const findings = pass.confirmed.filter(
      (f) => ids.has(f.shotId) && (item.panel.def.categories as readonly string[]).includes(f.category),
    );
    recordVerdicts(plan.ledger, checkRunId, item.identity, [
      { shots: item.shots, findings, reply: pass.replies.get(workKey(item)) },
    ]);
  }
}

/**
 * Both variants of every group: an aria-shown panel keys its verdicts on a
 * different hash of the same shots, and a prune set holding only the plain
 * one would drop those entries on every full-scope run.
 */
export function liveGroupHashes(shots: ShotRecord[]): Set<string> {
  return new Set(
    [...groupShots(shots).values()].flatMap((g) => [groupHash(g), groupHash(g, { aria: true })]),
  );
}

/**
 * Every panel call failing is a run that judged nothing, which must not read
 * as a clean result. One failing among several is reported and survived.
 */
export function assertSomeBatchAnswered(pass: JudgePass, log: (line: string) => void): void {
  if (pass.failedBatches.length > 0) {
    log(
      `${pass.failedBatches.length} panel call(s) failed and were not cached; ` +
        "the shots they cover are judged again next run",
    );
  }
  if (pass.failedBatches.length > 0 && pass.failedBatches.length === pass.batchCount) {
    throw new LookoutError(`every judge batch failed (${pass.batchCount})`, pass.failedBatches[0]!.message);
  }
}

/**
 * A shot is unjudged when ANY of its panels could not vouch for it: the
 * group's other panels may have cached, but the view as a whole was not
 * fully ruled on this run.
 */
export function unjudgedShotIds(plan: JudgePlan, pass: JudgePass): Set<string> {
  const ids = new Set<string>();
  for (const item of plan.toJudge) {
    if (!pass.uncacheable.has(workKey(item))) continue;
    for (const s of item.shots) ids.add(s.id);
  }
  return ids;
}

/** The report of one pass over one set of shots. Pure. */
export function buildOutcome(args: {
  plan: JudgePlan;
  pass: JudgePass;
  shots: ShotRecord[];
  runId: string;
  reportPath: string;
}): CheckOutcome {
  const { plan, pass, shots } = args;
  const allFindings = [...pass.confirmed, ...plan.cachedFindings];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  allFindings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const unjudged = unjudgedShotIds(plan, pass);
  return {
    runId: args.runId,
    model: plan.model,
    rubricVersion: Math.max(0, ...plan.panels.map((p) => p.version)),
    panels: plan.panels.map((p) => p.def.name),
    shotsConsidered: shots.length,
    judged: plan.toJudgeShots.length,
    cached: plan.cached,
    findings: allFindings,
    refuted: pass.refuted.map((r) => ({
      title: r.title,
      shotId: r.shotId,
      verifierNote: r.verifierNote,
      // Which panel filed the killed claim, so the lesson lands on its skill.
      judge: r.judge,
    })),
    repaired: pass.repaired,
    droppedCriteria: pass.droppedCriteria,
    degraded: pass.degraded,
    rejected: pass.rejected,
    unjudged: unjudged.size,
    unaccounted: pass.unaccounted,
    formFactors: tallyFormFactors(
      shots,
      new Set(plan.toJudgeShots.map((s) => s.id)),
      new Set(allFindings.map((f) => f.shotId)),
      unjudged,
    ),
    failedBatches: pass.failedBatches,
    deterministicErrors: shots.flatMap((s) => s.deterministicFindings).filter((f) => f.severity === "error").length,
    costUsd: Number(pass.costUsd.toFixed(4)),
    reportPath: args.reportPath,
  };
}

export function reportPathOf(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "judge-report.json");
}

export async function writeReport(outcome: CheckOutcome): Promise<void> {
  await writeFile(outcome.reportPath, JSON.stringify(outcome, null, 2));
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
  const checkRunId = runId("check");
  recordLedger(plan, pass, checkRunId);
  if (args.fullScope) {
    const dropped = pruneLedger(plan.ledger, liveGroupHashes(scope.shots));
    if (dropped > 0) log(`ledger: pruned ${dropped} unreachable cached verdict(s)`);
  }
  await saveLedger(resolved, plan.ledger);
  assertSomeBatchAnswered(pass, log);
  const outcome = buildOutcome({ plan, pass, shots: scope.shots, runId: checkRunId, reportPath: reportPathOf(resolved) });
  await writeReport(outcome);
  return outcome;
}
