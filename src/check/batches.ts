/**
 * Judging, batch by batch, with the refuter running behind each one.
 *
 * A view group is both the unit the rubric compares within and the unit that
 * streams: a larger batch buys nothing the judge can use and holds every
 * finding in it hostage until the whole batch returns, which on full-page
 * screenshots ran to several silent minutes.
 *
 * Nothing here treats one failure as the run failing. A batch that times out or
 * comes back unparseable used to reject its worker, take `Promise.all` with it,
 * and throw away every batch already judged before the ledger was written: on a
 * long run, minutes of judging and real money discarded because the last call
 * went wrong. A failed batch is recorded, left out of the cache so it is judged
 * again next time, and the run carries on. The one case that is fatal is every
 * batch failing, and that is decided by the caller, which knows how many there
 * were.
 */
import { evidenceDir } from "../config.js";
import { batchShots, judgeBatch, type AiFinding } from "../judge/engine.js";
import { verifyFindings, type VerifiedFinding } from "../judge/verify.js";
import { recordIncident } from "../skills/incidents.js";
import { emit } from "../report/events.js";
import type { JudgePlan } from "./plan.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import { num, type Parsed } from "../util.js";

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

export interface JudgePass {
  confirmed: VerifiedFinding[];
  refuted: (AiFinding & { verifierNote: string })[];
  /** Shots no verdict can be claimed for, so no verdict is cached for them. */
  uncacheable: Set<string>;
  failedBatches: { shots: number; message: string }[];
  rejected: number;
  costUsd: number;
  /** How many batches there were, which is what makes "all of them failed" decidable. */
  batchCount: number;
}

export async function judgeInBatches(args: {
  resolved: ResolvedConfig;
  plan: JudgePlan;
  shotsById: Map<string, ShotRecord>;
  parsed: Parsed;
  log: (line: string) => void;
  opts: RunCheckOptions;
}): Promise<JudgePass> {
  const { resolved, plan, shotsById, parsed, log, opts } = args;
  // 4. Judge in batches, a couple of subprocesses at a time.
  const evDir = evidenceDir(resolved);
  // One view group (a route and state across its form factors and schemes) is
  // both the unit the rubric compares within and the unit that streams: a
  // larger batch buys nothing the judge can use and holds every finding in it
  // hostage until the whole batch returns, which on full-page screenshots ran
  // to several silent minutes.
  const batches = batchShots(plan.toJudge);
  const concurrency = num(parsed.flags.concurrency) ?? 2;
  log(
    `judging ${plan.toJudge.length} shot(s) in ${batches.length} batch(es) with model ${plan.model} ` +
      `(${plan.cached} cached under judge skill v${plan.rubric.version})`,
  );
  emit("judge-start", `judging ${plan.toJudge.length} shot(s) in ${batches.length} batch(es)`, {
    shots: plan.toJudge.length,
    batches: batches.length,
    model: plan.model,
    cached: plan.cached,
  });
  if (opts.onStart) await opts.onStart(plan.toJudge);

  const confirmed: VerifiedFinding[] = [];
  const refuted: (AiFinding & { verifierNote: string })[] = [];
  /** Shots no verdict can be claimed for: the batch failed, or the reply skipped them. */
  const uncacheable = new Set<string>();
  const failedBatches: { shots: number; message: string }[] = [];
  let rejectedCount = 0;
  let costUsd = 0;
  let batchIndex = 0;

  // Callbacks run one at a time even though batches judge concurrently: they
  // write the backlog and print, and interleaving either would corrupt it.
  let tail: Promise<void> = Promise.resolve();
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    tail = tail.then(fn, fn);
    return tail;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = batchIndex++;
      if (i >= batches.length) return;
      const batch = batches[i]!;

      // One batch failing is not the run failing. Without this, a single
      // timeout or unparseable reply rejected the worker, took Promise.all with
      // it, and threw away every batch already judged before the ledger was
      // ever written: on a long run that is minutes of judging and real money
      // discarded because the last call went wrong. A failed batch is recorded,
      // left out of the cache so it is judged again next time, and the run
      // carries on.
      let res: Awaited<ReturnType<typeof judgeBatch>>;
      try {
        res = await judgeBatch(plan.rubric.text, resolved.project, batch, evDir, plan.model, {
          handoff: plan.rubric.handoff,
          prior: plan.prior,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const s of batch) uncacheable.add(s.id);
        failedBatches.push({ shots: batch.length, message });
        recordIncident({
          at: new Date().toISOString(),
          kind: "crash",
          verb: "check",
          message: `judge batch failed: ${message}`,
          project: resolved.project,
        });
        log(`  batch ${i + 1}/${batches.length}: FAILED (${message})`);
        emit("error", `batch ${i + 1}/${batches.length} failed: ${message}`, {}, "error");
        continue;
      }
      rejectedCount += res.rejected.length;
      costUsd += res.costUsd ?? 0;
      // A shot the reply accounted for in neither list has no verdict. Caching
      // the group as clean would make silence look like a clean bill of health,
      // durably; leaving it out means it is judged again next run.
      for (const id of res.unaccounted) uncacheable.add(id);

      // 5. Verify this batch now rather than at the end. A finding the caller
      // can act on immediately is worth more than a tidy single verify pass,
      // and the smaller prompts judge the same evidence either way.
      let batchFindings: VerifiedFinding[];
      if (parsed.flags["no-verify"] || res.findings.length === 0) {
        batchFindings = res.findings.map((f) => ({ ...f, verified: false }));
      } else {
        try {
          const v = await verifyFindings(plan.refute.text, res.findings, shotsById, evDir, plan.model);
          batchFindings = v.confirmed;
          refuted.push(...v.refuted);
          costUsd += v.costUsd ?? 0;
        } catch (e) {
          // The refuter failing is not grounds for dropping what the judge
          // found. The findings stand unverified, and the group is left out of
          // the cache so a later run can still refute them.
          batchFindings = res.findings.map((f) => ({ ...f, verified: false }));
          for (const s of batch) uncacheable.add(s.id);
          const message = e instanceof Error ? e.message : String(e);
          log(`  batch ${i + 1}/${batches.length}: verifier failed (${message}); findings unverified`);
          emit("error", `verifier failed on batch ${i + 1}: ${message}`, {}, "error");
        }
      }
      confirmed.push(...batchFindings);

      log(
        `  batch ${i + 1}/${batches.length}: ${batch.length} shot(s), ` +
          `${batchFindings.length} finding(s)` +
          (res.rejected.length ? `, ${res.rejected.length} rejected` : "") +
          ` (${(res.durationMs / 1000).toFixed(0)}s)`,
      );
      emit("batch", `batch ${i + 1}/${batches.length}: ${batchFindings.length} finding(s)`, {
        index: i + 1,
        total: batches.length,
        shots: batch.length,
        findings: batchFindings.length,
        seconds: Math.round(res.durationMs / 1000),
      });
      for (const f of batchFindings) {
        const shot = shotsById.get(f.shotId);
        emit(
          "finding",
          `${f.category}/${f.attribute}: ${f.title}`,
          {
            severity: f.severity,
            category: f.category,
            attribute: f.attribute,
            shotId: f.shotId,
            path: shot?.path,
            route: shot?.route,
            formFactor: shot?.formFactor,
            scheme: shot?.scheme,
            problem: f.problem,
            verified: f.verified,
          },
          f.severity,
        );
      }
      if (opts.onBatch) {
        await serialize(() =>
          opts.onBatch!({
            index: i,
            total: batches.length,
            shots: batch,
            findings: batchFindings,
            shotsById,
          }),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  await tail;
  if (refuted.length > 0) log(`verifier refuted ${refuted.length} finding(s)`);

  return {
    confirmed,
    refuted,
    uncacheable,
    failedBatches,
    rejected: rejectedCount,
    costUsd,
    batchCount: batches.length,
  };
}
