/**
 * Judging and filing one screen of the walk. The judges are the ordinary
 * ones over the ordinary unit (a view group), against skills loaded once
 * per run; what differs from a plain check is that the ledger is saved the
 * moment this screen's verdicts land, so a walk that dies on screen twelve
 * keeps eleven screens of judging.
 */
import { saveLedger } from "../judge/ledger.js";
import { issuesOf } from "../issues/registry.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import type { Parsed } from "../util.js";
import { judgeInBatches, type JudgePass } from "./batches.js";
import { buildOutcome, recordLedger, reportPathOf, type CheckOutcome, type RunCheckOptions } from "./outcome.js";
import { asPlan, type JudgePlan } from "./plan.js";
import type { LoadedJudging } from "./plan-load.js";
import { partitionGroups, priorNames } from "./plan-partition.js";
import { reverifyCached } from "./reverify.js";
import type { ScreenStop } from "./walk-order.js";

export interface JudgedStop {
  outcome: CheckOutcome;
  plan: JudgePlan;
  pass: JudgePass;
  /** Cached entries repaired by refute-on-read on this stop. */
  reverified: number;
  /** Every panel call of this stop failed, so the screen was not judged at all. */
  allFailed: boolean;
}

export async function judgeStop(args: {
  resolved: ResolvedConfig;
  loaded: LoadedJudging;
  shots: ShotRecord[];
  parsed: Parsed;
  log: (line: string) => void;
  opts: RunCheckOptions;
  runId: string;
  /** How much of the run's refute-on-read cap is left for this stop. */
  reverifyLeft: number;
}): Promise<JudgedStop> {
  const { resolved, loaded, shots, parsed, log } = args;
  const shotsById = new Map(shots.map((s) => [s.id, s]));
  // The names the backlog carries, re-read per stop: what the stop before
  // this one just filed is the name a repeat defect on this screen should
  // keep, and a list built once per run would not know it.
  const prior = await priorNames(resolved);
  const plan = asPlan(loaded, partitionGroups(loaded, shots, { noCache: !!parsed.flags["no-cache"] }), prior);
  const repairs = await reverifyCached({ resolved, plan, shotsById, parsed, log, limit: args.reverifyLeft });
  const pass = await judgeInBatches({ resolved, plan, shotsById, parsed, log, opts: args.opts });
  pass.refuted.push(...repairs.refuted);
  pass.costUsd += repairs.costUsd;
  recordLedger(plan, pass, args.runId);
  await saveLedger(resolved, plan.ledger);
  const outcome = buildOutcome({ plan, pass, shots, runId: args.runId, reportPath: reportPathOf(resolved) });
  return {
    outcome,
    plan,
    pass,
    reverified: repairs.repaired,
    allFailed: pass.batchCount > 0 && pass.failedBatches.length === pass.batchCount,
  };
}

export interface MergedStop {
  added: number;
  reopened: number;
  refreshed: number;
  placed: number;
}

/**
 * File what this screen turned up. The source scan runs on the first and
 * the last merge of a walk only: the source does not change during a run,
 * and re-walking the repository sixty times would answer nothing new.
 */
export async function mergeStop(
  resolved: ResolvedConfig,
  stop: ScreenStop,
  outcome: CheckOutcome,
  parsed: Parsed,
  o: { scanSource: boolean; place: boolean },
): Promise<MergedStop> {
  const { mergeLatest, saveBacklog } = await import("../verbs/backlog.js");
  const merged = await mergeLatest(resolved, { judgeOutcome: outcome, scanSource: o.scanSource });
  let placed = 0;
  // Under --first the run ends here, and an issue born on this screen would
  // never reach the full walk's placement sweep; bounded to this route.
  if (o.place && !parsed.flags["no-placement"]) {
    const { resolveInventory } = await import("../design/resolve.js");
    const { placeNewIssues } = await import("../design/place-issues.js");
    const inv = await resolveInventory(resolved);
    if (inv.kits[0]) {
      const here = issuesOf(merged.backlog, { statuses: ["open"] })
        .filter((c) => c.channel !== "code" && c.routes.includes(stop.route))
        .map((c) => c.id);
      const run = await placeNewIssues(resolved, merged.backlog, inv, { only: here });
      placed = run.placed;
      if (run.placed > 0) await saveBacklog(resolved, merged.backlog);
    }
  }
  return { added: merged.added, reopened: merged.reopened, refreshed: merged.refreshed, placed };
}
