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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { judgeBatch, type AiFinding, type ContractLapse, type PriorFinding } from "../judge/engine.js";
import { groupHash } from "../judge/ledger.js";
import { verifyFindings, type DroppedCriterion, type RepairedFinding, type VerifiedFinding } from "../judge/verify.js";
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
  /**
   * Shots a panel answered about but ruled on in neither list.
   *
   * The count of them has always been reported (as `unjudged`), which says a
   * verdict is missing without saying whose or about what. A panel that keeps
   * dropping the same kind of shot is a panel whose instructions are not
   * landing, and that is a lesson `skills improve` can act on only if the
   * panel and the shots are written down.
   */
  unaccounted: { panel: string; groupId: string; shotIds: string[] }[];
  failedBatches: { panel: string; shots: number; message: string }[];
  rejected: number;
  costUsd: number;
  /** Planned panel calls, which is what makes "all of them failed" decidable. */
  batchCount: number;
  /** Findings whose plain half the refuter supplied, with the panel that skipped it. */
  repaired: RepairedFinding[];
  /** Acceptance criteria dropped or rewritten at filing time, with their panel. */
  droppedCriteria: DroppedCriterion[];
  /** Findings filed with a problem written for one reader, with the panel that wrote it. */
  degraded: ContractLapse[];
  /**
   * Each successful panel call's reply, whole, as a file under the capture
   * workspace, keyed like `uncacheable`. The ledger entry for the verdict
   * points at it, so the reasoning a finding was distilled from can be read
   * back by whoever wants more than the distillate.
   */
  replies: Map<string, string>;
}

/**
 * A view group as a person would name it.
 *
 * The group id is built for identity and reads like one (`app|web|/|rest`);
 * this is the same group said out loud, which is what belongs in a line the
 * page puts in front of somebody.
 */
function viewLabel(shots: ShotRecord[]): string {
  const s = shots[0];
  if (!s) return "the view";
  // The same name a shot is narrated under, so the two lines read as one run.
  return `${s.target}${s.route}` + (s.state === "rest" ? "" : ` ${s.state}`);
}

/** The same cap the prior list uses: a naming aid, never a second manifest. */
const MAX_RUN_NAMES = 40;

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
  // Panel calls, not groups: a group is one line in the report and five
  // subprocesses in the clock, and quoting the smaller number made a run that
  // was working normally look like one that had hung.
  log(
    `judging ${plan.toJudgeShots.length} shot(s) in ${jobs.length} batch(es), ` +
      `${plan.toJudge.length} panel call(s) with model ${plan.model} ` +
      `(${plan.cached} cached under judge skill v${versionMax})`,
  );
  emit(
    "judge-start",
    `judging ${plan.toJudgeShots.length} shot(s): ${jobs.length} view group(s), ${plan.toJudge.length} panel call(s)`,
    {
      shots: plan.toJudgeShots.length,
      batches: jobs.length,
      panels: plan.toJudge.length,
      model: plan.model,
      cached: plan.cached,
    },
  );
  if (opts.onStart) await opts.onStart(plan.toJudgeShots);

  const confirmed: VerifiedFinding[] = [];
  const refuted: (AiFinding & { verifierNote: string })[] = [];
  const uncacheable = new Set<string>();
  const unaccounted: JudgePass["unaccounted"] = [];
  /**
   * Names this run has already minted, so later groups reuse them.
   *
   * The prior list is built once, before any judging, from what was already in
   * the backlog. Nothing told a group what the groups before it had just
   * filed, so one responsive-table defect could be filed as three attributes
   * across three routes in a single run: three issues, three fix sessions, and
   * an attempt history split three ways for one fix.
   *
   * They travel as "*" entries, the shape a defect open everywhere already
   * uses, because the point is precisely that the same defect may appear on a
   * view this call has not been handed. Appended synchronously inside a
   * worker's turn, which is all the mutual exclusion a single-threaded loop
   * needs. Two groups in flight at once are blind to each other and later ones
   * anchor on whichever finished first; that is order-dependent, and still
   * strictly better than every group minting its own name.
   *
   * Capped like the prior list, and for the same reason: this is a naming aid,
   * and past a certain length it becomes a second manifest the judge has to
   * read before it looks at the screenshots.
   */
  const filedSoFar: PriorFinding[] = [];
  const filedKeys = new Set<string>();
  const replies = new Map<string, string>();
  const repaired: RepairedFinding[] = [];
  const droppedCriteria: DroppedCriterion[] = [];
  const degraded: ContractLapse[] = [];
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
      let panelIndex = 0;
      for (const item of job.items) {
        const panelName = item.panel.def.name;
        // One "batch" is one view group, and a view group is judged once per
        // panel: five sequential calls of a minute each. Saying only that
        // judging had started left the page with nothing to show for the whole
        // of it, which reads exactly like a run that has died.
        emit("phase", `${panelName} on ${viewLabel(job.shots)} (${++panelIndex}/${job.items.length})`, {
          panel: panelName,
          groupId: job.groupId,
          index: panelIndex,
          total: job.items.length,
        });
        let res: Awaited<ReturnType<typeof judgeBatch>>;
        try {
          res = await judgeBatch(item.panel.text, resolved.project, job.shots, evDir, plan.model, {
            handoff: item.panel.handoff,
            // Priors travel per lane: an out-of-lane prior instructs the judge
            // to re-file it, which the lane rule would then reject.
            prior: [...plan.prior, ...filedSoFar].filter((p) =>
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
        degraded.push(...res.degraded);
        costUsd += res.costUsd ?? 0;
        durationMs += res.durationMs;
        // The reply, whole, beside the screenshots it is about. Best effort:
        // a transcript that cannot be written is a missing pointer, never a
        // failed batch.
        if (res.raw) {
          const rel = join("judge-replies", `${groupHash(job.shots).slice(0, 12)}@${panelName}.txt`);
          try {
            await mkdir(join(evDir, "judge-replies"), { recursive: true });
            await writeFile(join(evDir, rel), res.raw);
            replies.set(workKey(item), rel);
          } catch {
            // Nothing: the verdict stands without its transcript.
          }
        }
        // A shot the reply accounted for in neither list has no verdict from
        // this panel. Caching would make silence look like a clean bill of
        // health, durably; left out, the pair is judged again next run.
        if (res.unaccounted.length > 0) {
          uncacheable.add(workKey(item));
          unaccounted.push({ panel: panelName, groupId: job.groupId, shotIds: res.unaccounted });
        }
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
          repaired.push(...v.repaired);
          droppedCriteria.push(...v.droppedCriteria);
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
      // What this group just filed becomes a name later groups can reuse.
      // Confirmed only: a refuted claim is not a defect, and offering its name
      // would invite the next group to file the thing the refuter just killed.
      for (const f of jobFindings) {
        const key = `${f.category}|${f.attribute}`;
        if (filedKeys.has(key) || filedSoFar.length >= MAX_RUN_NAMES) continue;
        filedKeys.add(key);
        filedSoFar.push({
          shotId: "*",
          category: f.category,
          attribute: f.attribute,
          title: f.title,
          region: f.region,
        });
      }

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
    unaccounted,
    failedBatches,
    rejected: rejectedCount,
    costUsd,
    batchCount: plan.toJudge.length,
    replies,
    repaired,
    droppedCriteria,
    degraded,
  };
}
