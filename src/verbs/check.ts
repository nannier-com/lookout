/**
 * `lookout check`: capture (unless --no-capture) then judge the evidence with
 * the local Claude Code CLI against the base rubric plus the project
 * extension. Ledger-cached per shot hash, adversarially verified for
 * critical/high, written to .lookout/evidence/judge-report.json.
 *
 * Exit 1 when any confirmed AI finding or error-severity deterministic
 * finding stands; 0 when clean.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, evidenceDir } from "../config.js";
import { loadReport } from "../capture/store.js";
import { batchShots, groupShots, judgeBatch, type AiFinding } from "../judge/engine.js";
import { loadRubric } from "../judge/rubric.js";
import { groupHash, ledgerKey, loadLedger, recordVerdicts, saveLedger } from "../judge/ledger.js";
import { verifyFindings, type VerifiedFinding } from "../judge/verify.js";
import { LookoutError, type Severity, type ShotRecord } from "../types.js";
import { list, num, printJson, runId, str, type Parsed } from "../util.js";
import { runCapture, runContactSheet } from "./capture.js";
import { sheetNote } from "../capture/sheet.js";
import { SEVERITIES } from "../judge/rubric.js";
import { clusterFindings } from "../fix/cluster.js";
import { writeFixPlan } from "../fix/plan.js";
import { planPath } from "../fix/state.js";
import type { FixPlan } from "../fix/brief.js";
import type { Backlog } from "../backlog/lib.js";
import { createAutoStreamer, type BatchEvent } from "../fix/stream.js";

/** Attempts a cluster gets before `verify-fix` blocks it. */
export const DEFAULT_MAX_ATTEMPTS = 2;

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
  deterministicErrors: number;
  costUsd: number;
  reportPath: string;
}

export interface RunCheckOptions {
  /** Called once the cache partition is known, before any judging begins. */
  onStart?: (toJudge: ShotRecord[]) => Promise<void>;
  /**
   * Invoked after each batch is judged AND verified, in order, never
   * concurrently. This is what lets a caller act on findings while the rest of
   * the app is still being judged instead of waiting for the slowest batch.
   */
  onBatch?: (e: BatchEvent) => Promise<void>;
}

export async function runCheck(
  parsed: Parsed,
  opts: RunCheckOptions = {},
): Promise<{
  outcome: CheckOutcome;
  resolved: Awaited<ReturnType<typeof loadConfig>>;
  shotsById: Map<string, ShotRecord>;
  toJudge: ShotRecord[];
}> {
  // 1. Fresh evidence unless the caller judges an existing set.
  let resolved;
  if (parsed.flags["no-capture"]) {
    resolved = await loadConfig({ configPath: str(parsed.flags.config), url: str(parsed.flags.url) });
  } else {
    resolved = (await runCapture(parsed)).resolved;
  }

  const report = await loadReport(resolved);
  if (!report || report.shots.length === 0) {
    throw new LookoutError(
      "no captured evidence to judge",
      "run `lookout capture` first, or drop --no-capture",
    );
  }

  // 2. Scope selection mirrors capture's flags.
  const onlyTargets = list(parsed.flags.targets);
  const onlyRoutes = list(parsed.flags.routes);
  const shots = report.shots.filter(
    (s) =>
      s.platform === "web" &&
      (!onlyTargets || onlyTargets.includes(s.target)) &&
      (!onlyRoutes ||
        onlyRoutes.some((r) => s.route === r || s.route === `/${r}` || s.routeName === r)),
  );
  if (shots.length === 0) throw new LookoutError("no shots match the given --targets/--routes");
  const shotsById = new Map(shots.map((s) => [s.id, s]));

  // 3. Rubric + cache partition.
  const rubric = await loadRubric(resolved);
  const model = str(parsed.flags.model) ?? "sonnet";
  const ledger = await loadLedger(resolved);
  const toJudge: ShotRecord[] = [];
  const cachedFindings: (VerifiedFinding & { cached: boolean })[] = [];
  let cached = 0;
  // Cache by view group, not by single shot: a group re-judges whole whenever
  // any member's pixels moved, so a comparative finding never loses the shot
  // it compares against. Per-shot caching made a scoped re-check report a
  // dark/light or responsive finding as gone when only its partner had changed,
  // which is exactly the false "fixed" the auto loop must never see.
  for (const group of groupShots(shots).values()) {
    const entry = ledger.entries[ledgerKey(groupHash(group), rubric.version, model)];
    if (entry && !group.some((s) => s.animated)) {
      cached += group.length;
      for (const f of entry.findings ?? []) {
        cachedFindings.push({ ...f, verified: true, cached: true });
      }
    } else {
      toJudge.push(...group);
    }
  }

  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string) => {
    if (!quiet) console.log(line);
  };

  // 4. Judge in batches, a couple of subprocesses at a time.
  const evDir = evidenceDir(resolved);
  const batches = batchShots(toJudge, num(parsed.flags["batch-size"]) ?? 10);
  const concurrency = num(parsed.flags.concurrency) ?? 2;
  log(
    `judging ${toJudge.length} shot(s) in ${batches.length} batch(es) with model ${model} ` +
      `(${cached} cached under rubric v${rubric.version})`,
  );
  if (opts.onStart) await opts.onStart(toJudge);

  const confirmed: VerifiedFinding[] = [];
  const refuted: (AiFinding & { verifierNote: string })[] = [];
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
      const res = await judgeBatch(rubric.text, resolved.project, batch, evDir, model);
      rejectedCount += res.rejected.length;
      costUsd += res.costUsd ?? 0;

      // 5. Verify this batch now rather than at the end. A finding the caller
      // can act on immediately is worth more than a tidy single verify pass,
      // and the smaller prompts judge the same evidence either way.
      let batchFindings: VerifiedFinding[];
      if (parsed.flags["no-verify"] || res.findings.length === 0) {
        batchFindings = res.findings.map((f) => ({ ...f, verified: false }));
      } else {
        const v = await verifyFindings(res.findings, shotsById, evDir, model);
        batchFindings = v.confirmed;
        refuted.push(...v.refuted);
        costUsd += v.costUsd ?? 0;
      }
      confirmed.push(...batchFindings);

      log(
        `  batch ${i + 1}/${batches.length}: ${batch.length} shot(s), ` +
          `${batchFindings.length} finding(s)` +
          (res.rejected.length ? `, ${res.rejected.length} rejected` : "") +
          ` (${(res.durationMs / 1000).toFixed(0)}s)`,
      );
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

  // 6. Ledger: judged shots record their post-verification findings.
  const checkRunId = runId("check");
  const judgedGroups = [...groupShots(toJudge).values()].map((members) => {
    const ids = new Set(members.map((s) => s.id));
    return { shots: members, findings: confirmed.filter((f) => ids.has(f.shotId)) };
  });
  recordVerdicts(ledger, checkRunId, rubric.version, model, judgedGroups);
  await saveLedger(resolved, ledger);

  const allFindings = [...confirmed, ...cachedFindings];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  allFindings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const deterministicErrors = shots
    .flatMap((s) => s.deterministicFindings)
    .filter((f) => f.severity === "error").length;

  const reportPath = join(evDir, "judge-report.json");
  const outcome: CheckOutcome = {
    runId: checkRunId,
    model,
    rubricVersion: rubric.version,
    shotsConsidered: shots.length,
    judged: toJudge.length,
    cached,
    findings: allFindings,
    refuted: refuted.map((r) => ({ title: r.title, shotId: r.shotId, verifierNote: r.verifierNote })),
    rejected: rejectedCount,
    deterministicErrors,
    costUsd: Number(costUsd.toFixed(4)),
    reportPath,
  };
  await writeFile(reportPath, JSON.stringify(outcome, null, 2));
  return { outcome, resolved, shotsById, toJudge };
}

/** The worst-acceptable severity `--auto` dispatches; critical and high by default. */
export function autoSeverity(parsed: Parsed): Severity {
  const raw = str(parsed.flags.severity);
  if (!raw) return "high";
  if (!(SEVERITIES as readonly string[]).includes(raw)) {
    throw new LookoutError(
      `unknown --severity "${raw}"`,
      `one of: ${SEVERITIES.join(", ")}`,
    );
  }
  return raw as Severity;
}

export async function check(parsed: Parsed): Promise<number> {
  const auto = !!parsed.flags.auto;
  const maxAttempts = num(parsed.flags["max-attempts"]) ?? DEFAULT_MAX_ATTEMPTS;
  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;

  // In auto mode the streamer emits as evidence lands: deterministic clusters
  // before judging even starts, judged clusters as soon as their routes are
  // done. The session can be spawning fix sessions while the rest of the app
  // is still being looked at.
  let streamer: ReturnType<typeof createAutoStreamer> | null = null;
  if (auto) {
    const pre = await loadConfig({
      configPath: str(parsed.flags.config),
      url: str(parsed.flags.url),
    });
    if (!pre.configPath) {
      throw new LookoutError(
        "--auto needs a project backlog",
        "run `lookout init` to create .lookout/config.ts; zero-config runs are report-only",
      );
    }
    streamer = createAutoStreamer({
      resolved: pre,
      runId: runId("auto"),
      minSeverity: autoSeverity(parsed),
      maxAttempts,
      log: (line) => {
        if (!quiet) console.log(line);
      },
    });
  }

  const { outcome, resolved, shotsById } = await runCheck(
    parsed,
    streamer
      ? { onStart: (toJudge) => streamer!.start(toJudge), onBatch: (e) => streamer!.onBatch(e) }
      : {},
  );
  const streamed = streamer ? await streamer.finish() : null;

  // Projects with a config file track findings in the backlog automatically;
  // zero-config runs stay report-only (a backlog in a random cwd is noise).
  let backlogNote = "";
  let backlog: Backlog | null = null;
  if (resolved.configPath) {
    const { mergeLatest } = await import("./backlog.js");
    const merged = await mergeLatest(resolved, { judgeOutcome: outcome });
    backlog = merged.backlog;
    backlogNote = `backlog: ${merged.added} added, ${merged.reopened} reopened, ${merged.refreshed} refreshed`;
  }

  // The plan file is the settled record of what was dispatched; the streamer
  // already printed each cluster as it became dispatchable.
  let plan: FixPlan | null = null;
  if (auto && backlog) {
    plan = await writeFixPlan(
      resolved,
      clusterFindings(Object.values(backlog.findings), {
        minSeverity: autoSeverity(parsed),
        maxAttempts,
      }),
      { runId: outcome.runId, maxAttempts },
    );
  }

  // The session running lookout should be able to look at what lookout looked
  // at. One labelled sheet costs a single Read; the full-resolution paths below
  // it are there when a finding needs close reading.
  const findingsByShot = new Map<string, number>();
  for (const f of outcome.findings) {
    findingsByShot.set(f.shotId, (findingsByShot.get(f.shotId) ?? 0) + 1);
  }
  const sheet = await runContactSheet(resolved, [...shotsById.values()], findingsByShot);

  if (parsed.flags.json) {
    printJson({ ...outcome, contactSheet: sheet?.path ?? null, ...(plan ? { plan } : {}) });
  } else if (plan) {
    console.log(
      `\nall ${plan.clusters.length} cluster(s) dispatched` +
        (streamed && streamed.dispatched.length !== plan.clusters.length
          ? ` (${streamed.dispatched.length} emitted while judging)`
          : "") +
        `; plan: ${planPath(resolved)}`,
    );
    if (sheet) console.log(`\n${sheetNote(sheet)}`);
    if (backlogNote) console.log(`\n${backlogNote}`);
  } else {
    console.log(
      `\n${outcome.shotsConsidered} shot(s): ${outcome.judged} judged, ${outcome.cached} cached; ` +
        `${outcome.findings.length} finding(s), ${outcome.refuted.length} refuted; ` +
        `${outcome.deterministicErrors} deterministic error(s); ~$${outcome.costUsd}`,
    );
    for (const f of outcome.findings) {
      const shot = shotsById.get(f.shotId);
      console.log(
        `  [${f.severity}] ${f.category}/${f.attribute} ${f.title}` +
          `\n    shot: ${f.shotId}${f.cached ? " (cached)" : ""}${f.verified ? " (verified)" : ""}` +
          (shot ? `\n    evidence: ${join(evidenceDir(resolved), shot.path)}` : ""),
      );
    }
    console.log(`\nreport: ${outcome.reportPath}`);
    if (sheet) console.log(`\n${sheetNote(sheet)}`);
    if (backlogNote) console.log(backlogNote);
  }
  return outcome.findings.length > 0 || outcome.deterministicErrors > 0 ? 1 : 0;
}
