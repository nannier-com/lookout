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
import { judgeBatch, type AiFinding } from "../judge/engine.js";
import { verifyFindings, type VerifiedFinding } from "../judge/verify.js";
import { recordIncident } from "../skills/incidents.js";
import { emit } from "../report/events.js";
import type { JudgePlan, PanelWork } from "./plan.js";
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
  /**
   * The (group, panel) pairs no verdict can be claimed for, as
   * `${groupId}|${panel}`: the panel's call failed, or its reply skipped a
   * shot. The sibling panels of the same group still cache.
   */
  uncacheable: Set<string>;
  failedBatches: { panel: string; shots: number; message: string }[];
  rejected: number;
  costUsd: number;
  /** Planned panel calls, which is what makes "all of them failed" decidable. */
  batchCount: number;
}

/** The uncacheable-set member for one unit of panel work. */
export function workKey(item: Pick<PanelWork, "groupId"> & { panel: { def: { name: string } } }): string {
  return `${item.groupId}|${item.panel.def.name}`;
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
  // to several silent minutes. The group is also the SCHEDULING unit: its
  // panels run sequentially inside one worker turn, which is what lets one
  // pooled refuter call cover the whole group without a join.
  const jobs: { groupId: string; shots: ShotRecord[]; items: PanelWork[] }[] = [];
  for (const item of plan.toJudge) {
    const last = jobs[jobs.length - 1];
    if (last && last.groupId === item.groupId) last.items.push(item);
    else jobs.push({ groupId: item.groupId, shots: item.shots, items: [item] });
  }
  const versionMax = Math.max(0, ...plan.panels.map((p) => p.version));
  const concurrency = num(parsed.flags.concurrency) ?? 2;
  log(
    `judging ${plan.toJudgeShots.length} shot(s) in ${jobs.length} batch(es) with model ${plan.model} ` +
      `(${plan.cached} cached under judge skill v${versionMax})`,
  );
  emit("judge-start", `judging ${plan.toJudgeShots.length} shot(s) in ${jobs.length} batch(es)`, {
    shots: plan.toJudgeShots.length,
    batches: jobs.length,
    model: plan.model,
    cached: plan.cached,
  });
  if (opts.onStart) await opts.onStart(plan.toJudgeShots);

  const confirmed: VerifiedFinding[] = [];
  const refuted: (AiFinding & { verifierNote: string })[] = [];
  const uncacheable = new Set<string>();
  const failedBatches: { panel: string; shots: number; message: string }[] = [];
  let rejectedCount = 0;
  let costUsd = 0;
  let jobIndex = 0;

  // Callbacks run one at a time even though groups judge concurrently: they
  // write the backlog and print, and interleaving either would corrupt it.
  let tail: Promise<void> = Promise.resolve();
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    tail = tail.then(fn, fn);
    return tail;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = jobIndex++;
      if (i >= jobs.length) return;
      const job = jobs[i]!;

      // One panel failing is not the group failing, and one group failing is
      // not the run failing. A failed call is recorded, its (group, panel)
      // pair is left out of the cache so it is judged again next time, and
      // the sibling panels' verdicts still count.
      const fresh: AiFinding[] = [];
      let durationMs = 0;
      let rejectedHere = 0;
      for (const item of job.items) {
        const panelName = item.panel.def.name;
        let res: Awaited<ReturnType<typeof judgeBatch>>;
        try {
          res = await judgeBatch(item.panel.text, resolved.project, job.shots, evDir, plan.model, {
            handoff: item.panel.handoff,
            // Priors travel per lane: an out-of-lane prior instructs the judge
            // to re-file it, which the lane rule would then reject.
            prior: plan.prior.filter((p) =>
              (item.panel.def.categories as readonly string[]).includes(p.category),
            ),
            panel: { name: panelName, categories: item.panel.def.categories },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          uncacheable.add(workKey(item));
          failedBatches.push({ panel: panelName, shots: job.shots.length, message });
          recordIncident({
            at: new Date().toISOString(),
            kind: "crash",
            verb: "check",
            message: `judge batch failed: ${message}`,
            project: resolved.project,
            judge: panelName,
          });
          log(`  batch ${i + 1}/${jobs.length}: ${panelName} FAILED (${message})`);
          emit("error", `batch ${i + 1}/${jobs.length} ${panelName} failed: ${message}`, {}, "error");
          continue;
        }
        rejectedHere += res.rejected.length;
        costUsd += res.costUsd ?? 0;
        durationMs += res.durationMs;
        // A shot the reply accounted for in neither list has no verdict from
        // this panel. Caching would make silence look like a clean bill of
        // health, durably; left out, the pair is judged again next run.
        if (res.unaccounted.length > 0) uncacheable.add(workKey(item));
        fresh.push(...res.findings);
      }
      rejectedCount += rejectedHere;

      // 5. Verify this group now rather than at the end, and pooled: one
      // refuter call over every panel's findings for the group, which is the
      // mixed-findings context the refute skill was written and graded for.
      let jobFindings: VerifiedFinding[];
      if (parsed.flags["no-verify"] || fresh.length === 0) {
        jobFindings = fresh.map((f) => ({ ...f, verified: false }));
      } else {
        try {
          const v = await verifyFindings(plan.refute.text, fresh, shotsById, evDir, plan.model);
          jobFindings = v.confirmed;
          refuted.push(...v.refuted);
          costUsd += v.costUsd ?? 0;
        } catch (e) {
          // The refuter failing is not grounds for dropping what the judges
          // found, and not grounds for re-buying their work either. The
          // findings stand unverified and the pairs cache WITH them: the
          // verdicts are real, only the refutation is missing, and
          // refute-on-read (check/reverify.ts) repairs exactly that on the
          // next run without a second judge call.
          jobFindings = fresh.map((f) => ({ ...f, verified: false }));
          const message = e instanceof Error ? e.message : String(e);
          log(`  batch ${i + 1}/${jobs.length}: verifier failed (${message}); findings unverified`);
          emit("error", `verifier failed on batch ${i + 1}: ${message}`, {}, "error");
        }
      }
      confirmed.push(...jobFindings);

      log(
        `  batch ${i + 1}/${jobs.length}: ${job.shots.length} shot(s), ${job.items.length} panel(s), ` +
          `${jobFindings.length} finding(s)` +
          (rejectedHere ? `, ${rejectedHere} rejected` : "") +
          ` (${(durationMs / 1000).toFixed(0)}s)`,
      );
      emit("batch", `batch ${i + 1}/${jobs.length}: ${jobFindings.length} finding(s)`, {
        index: i + 1,
        total: jobs.length,
        shots: job.shots.length,
        panels: job.items.length,
        findings: jobFindings.length,
        seconds: Math.round(durationMs / 1000),
      });
      for (const f of jobFindings) {
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
            total: jobs.length,
            shots: job.shots,
            findings: jobFindings,
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
    batchCount: plan.toJudge.length,
  };
}
