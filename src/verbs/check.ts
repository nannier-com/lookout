/**
 * `lookout check`: capture (unless --no-capture) then judge the evidence with
 * the local Claude Code CLI against the base rubric plus the project
 * extension. Ledger-cached per VIEW GROUP (the comment below says why a per-shot
 * cache was wrong), adversarially verified for critical/high, written to
 * .lookout/evidence/judge-report.json.
 *
 * A batch that fails does not fail the run: it is recorded, left out of the
 * cache so it is judged again next time, and the rest of the run stands. Only a
 * run where every batch failed is an error, because that one judged nothing.
 *
 * Exit 1 when any confirmed AI finding or error-severity deterministic
 * finding stands; 0 when clean.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, evidenceDir } from "../config.js";
import { loadReport } from "../capture/store.js";
import {
  batchShots,
  groupShots,
  judgeBatch,
  type AiFinding,
  type PriorFinding,
} from "../judge/engine.js";
import { loadRubric } from "../judge/rubric.js";
import { loadSkill } from "../skills/load.js";
import { recordIncident } from "../skills/incidents.js";
import { sheetNote } from "../capture/sheet.js";
import {
  groupHash,
  judgeIdentity,
  ledgerKey,
  loadLedger,
  recordVerdicts,
  saveLedger,
} from "../judge/ledger.js";
import { verifyFindings, type VerifiedFinding } from "../judge/verify.js";
import { LookoutError, type ResolvedConfig, type Severity, type ShotRecord } from "../types.js";
import { list, num, printJson, runId, str, type Parsed } from "../util.js";
import { runCapture, runContactSheet } from "./capture.js";
import { resolveTargets } from "../targets.js";
import { SEVERITIES } from "../judge/rubric.js";
import { emit, EventLog, setCurrentLog } from "../report/events.js";

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
    resolved = await loadConfig({ configPath: str(parsed.flags.config), url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]) });
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

  // 3. Skills + cache partition. Both AI passes are loaded once per run: a
  // skill amended mid-run would judge two batches by two different rules.
  const rubric = await loadRubric(resolved);
  const refute = await loadSkill(resolved, "refute-finding");
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
  const identity = judgeIdentity({
    version: rubric.version,
    rubricText: rubric.text,
    refuteText: refute.text,
    model,
  });
  for (const group of groupShots(shots).values()) {
    const entry = ledger.entries[ledgerKey(groupHash(group), identity)];
    if (entry && !group.some((s) => s.animated)) {
      cached += group.length;
      for (const f of entry.findings ?? []) {
        // `verified` is read back, not asserted. A --no-verify run records
        // findings the refuter never saw, and medium and low findings are never
        // refuted at all, so stamping true here reported a check that had not
        // happened, in the one field that says how much to trust the finding.
        cachedFindings.push({ ...f, verified: f.verified ?? false, cached: true });
      }
    } else {
      toJudge.push(...group);
    }
  }

  // What lookout already has open on these views. The judge writes the
  // `attribute` freehand, and it is half of both the fingerprint and the cluster
  // key, so the same defect returning under a different word mints a second
  // issue and splits the attempt history of the first. Showing it the name a
  // defect already carries is a few lines of prompt and keeps one defect one
  // issue. Only AI findings: the deterministic ones reach the judge as `signals`
  // on the shot, and it is told not to restate those.
  const prior: PriorFinding[] = [];
  if (resolved.configPath) {
    const { loadBacklog } = await import("./backlog.js");
    const b = await loadBacklog(resolved);
    const seen = new Set<string>();
    for (const f of Object.values(b.findings)) {
      if (f.status !== "open" || f.channel !== "ai") continue;
      for (const ev of f.evidence) {
        const key = `${ev.shotId}|${f.category}|${f.attribute}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prior.push({
          shotId: ev.shotId,
          category: f.category,
          attribute: f.attribute,
          title: f.title,
        });
      }
    }
  }

  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string) => {
    if (!quiet) console.log(line);
  };

  // 4. Judge in batches, a couple of subprocesses at a time.
  const evDir = evidenceDir(resolved);
  // One view group (a route and state across its form factors and schemes) is
  // both the unit the rubric compares within and the unit that streams: a
  // larger batch buys nothing the judge can use and holds every finding in it
  // hostage until the whole batch returns, which on full-page screenshots ran
  // to several silent minutes.
  const batches = batchShots(toJudge);
  const concurrency = num(parsed.flags.concurrency) ?? 2;
  log(
    `judging ${toJudge.length} shot(s) in ${batches.length} batch(es) with model ${model} ` +
      `(${cached} cached under judge skill v${rubric.version})`,
  );
  emit("judge-start", `judging ${toJudge.length} shot(s) in ${batches.length} batch(es)`, {
    shots: toJudge.length,
    batches: batches.length,
    model,
    cached,
  });
  if (opts.onStart) await opts.onStart(toJudge);

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
        res = await judgeBatch(rubric.text, resolved.project, batch, evDir, model, {
          handoff: rubric.handoff,
          prior,
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
          const v = await verifyFindings(refute.text, res.findings, shotsById, evDir, model);
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

  // 6. Ledger: judged shots record their post-verification findings.
  //
  // Only groups lookout can actually vouch for. A group whose batch failed, or
  // whose reply left a member in neither findings nor cleanShotIds, has no
  // verdict, and writing "clean" for it would turn silence into a durable clean
  // bill of health. Left out, it is simply judged again next run.
  const checkRunId = runId("check");
  const judgedGroups = [...groupShots(toJudge).values()]
    .filter((members) => !members.some((s) => uncacheable.has(s.id)))
    .map((members) => {
      const ids = new Set(members.map((s) => s.id));
      return { shots: members, findings: confirmed.filter((f) => ids.has(f.shotId)) };
    });
  recordVerdicts(ledger, checkRunId, identity, judgedGroups);
  await saveLedger(resolved, ledger);

  if (failedBatches.length > 0) {
    log(
      `${failedBatches.length} batch(es) failed and were not cached; ` +
        "the shots they cover are judged again next run",
    );
  }
  // Every batch failing is a run that judged nothing, which must not read as a
  // clean result. One failing among several is reported and survived.
  if (failedBatches.length > 0 && failedBatches.length === batches.length) {
    throw new LookoutError(
      `every judge batch failed (${batches.length})`,
      failedBatches[0]!.message,
    );
  }

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
    unjudged: uncacheable.size,
    failedBatches,
    deterministicErrors,
    costUsd: Number(costUsd.toFixed(4)),
    reportPath,
  };
  await writeFile(reportPath, JSON.stringify(outcome, null, 2));
  return { outcome, resolved, shotsById, toJudge };
}

/** The worst-acceptable severity a caller cares about; critical and high by default. */
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

/**
 * One issue, found as cheaply as it can be.
 *
 * Each route is captured and judged on its own, in config order, and the walk
 * stops at the first that turns something up. A route is a handful of
 * screenshots rather than the whole application, so a run that finds something
 * early costs a fraction of a full sweep, and one that finds nothing costs the
 * same as a full sweep and says so.
 */
async function firstIssue(parsed: Parsed, pre: ResolvedConfig): Promise<number> {
  const targets = resolveTargets(
    pre.config,
    list(parsed.flags.targets),
    list(parsed.flags.routes),
    pre.configPath,
  );
  const stops: { target: string; route: string }[] = [];
  for (const t of targets) for (const r of t.routes) stops.push({ target: t.def.name, route: r.path });

  if (stops.length === 0) throw new LookoutError("no routes match the given --targets/--routes");
  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string): void => {
    if (!quiet) console.log(line);
  };

  for (const [i, stop] of stops.entries()) {
    emit("phase", `looking at ${stop.target}${stop.route} (${i + 1}/${stops.length})`);
    log(`\n[${i + 1}/${stops.length}] ${stop.target}${stop.route}`);
    // One route at a time, through the ordinary path: same capture, same judge,
    // same rules, just scoped.
    const scoped: Parsed = {
      ...parsed,
      flags: { ...parsed.flags, targets: stop.target, routes: stop.route },
    };
    const { outcome, resolved } = await runCheck(scoped, {});
    const { mergeLatest } = await import("./backlog.js");
    // Everything this route turned up is filed. lookout captured and judged it
    // already, so dropping any of it would throw away work it has done and
    // report the route as healthier than it found it.
    //
    // No conformance read here on purpose. `--first` exists to find one issue
    // as cheaply as possible, and a conformance sweep reads the application's
    // source rather than this route, so it would spend the same money on every
    // stop of the walk to answer a question that has nothing to do with which
    // route was captured. A full `check` is where that question is asked.
    const merged = await mergeLatest(resolved, { judgeOutcome: outcome, scanSource: true });

    const found = merged.added + merged.reopened;
    if (found > 0) {
      const note =
        `${found} issue(s) on ${stop.target}${stop.route}, ` +
        `after looking at ${i + 1} of ${stops.length} route(s)`;
      log(`\n${note}`);
      emit("note", note, { route: stop.route, checked: i + 1, of: stops.length, found });
      emit("run-end", note, { findings: found, costUsd: outcome.costUsd });
      if (parsed.flags.json) printJson({ ...outcome, foundOn: stop.route, checked: i + 1 });
      return 1;
    }
    log(`  nothing on ${stop.route}`);
  }

  // Every route looked at, nothing found: that is a real result and worth
  // saying as clearly as a finding would be.
  const clean = `no issues found across ${stops.length} route(s)`;
  log(`\n${clean}`);
  emit("run-end", clean, { findings: 0 });
  if (parsed.flags.json) printJson({ findings: [], checked: stops.length });
  return 0;
}

export async function check(parsed: Parsed): Promise<number> {
  const checkRun = runId("check");

  // Narrate to disk from the first moment. A run takes minutes and its stdout
  // does not reach the caller until it exits, so `lookout status` and `lookout
  // ui` read this instead, while the run is still going.
  const pre = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
  });
  const elog = new EventLog(pre, checkRun);
  elog.start("lookout check", {
    project: pre.project,
    targets: str(parsed.flags.targets) ?? null,
    routes: str(parsed.flags.routes) ?? null,
  });
  setCurrentLog(elog);

  // Asked for one issue? Then walk the application one route at a time and
  // stop the moment something is found. Capturing all thirteen routes across
  // every form factor and scheme before judging anything is exactly what "find
  // me one issue" is asking you not to do: it is seventy-odd screenshots and
  // several minutes to answer a question that the first route usually settles.
  if (parsed.flags.first && pre.configPath) {
    const code = await firstIssue(parsed, pre);
    setCurrentLog(null);
    return code;
  }

  const { outcome, resolved, shotsById } = await runCheck(parsed, {});

  // Projects with a config file track findings in the backlog automatically;
  // zero-config runs stay report-only (a backlog in a random cwd is noise).
  let backlogNote = "";
  if (resolved.configPath) {
    const { mergeLatest, saveBacklog } = await import("./backlog.js");
    // Reading the application for hand-rolled controls, which is the half of
    // the code channel no screenshot and no regex can reach. On by default,
    // capped, and switched off with --no-conformance: a run that spends money
    // with no way to say no is a run people stop making. Unchanged files are
    // carried from the cache, so the cost falls to nearly nothing on a repeat.
    const merged = await mergeLatest(resolved, {
      judgeOutcome: outcome,
      scanSource: true,
      ...(parsed.flags["no-conformance"]
        ? {}
        : {
            conformance: {
              model: str(parsed.flags.model),
              fileBudget: num(parsed.flags["max-conformance"]),
            },
          }),
    });
    backlogNote = `backlog: ${merged.added} added, ${merged.reopened} reopened, ${merged.refreshed} refreshed`;
    if (merged.conformance) {
      const c = merged.conformance;
      backlogNote +=
        `; conformance: ${c.read} of ${c.considered} file(s) read (${c.cached} cached), ` +
        `${c.found} hand-rolled control(s), ${c.refuted} suspicion(s) refuted` +
        (c.unread > 0 ? `, ${c.unread} not read` : "");
    }

    // Where each new issue belongs, in a project that has a design system. A
    // defect is found on a screen and fixed in a component, and those are
    // rarely the same file, so the issue document says which before anybody
    // opens it. Once per issue, ever: it is a fact about the codebase.
    // Placement costs a model call per newly filed issue, so it has an off
    // switch and a cap. Neither is a default anybody should have to reach for,
    // but a first sweep of a neglected project can file a lot at once, and a
    // tool that spends money with no way to say no is one people stop running.
    if (!parsed.flags["no-placement"]) {
      const { resolveInventory } = await import("../design/resolve.js");
      const { placeNewIssues } = await import("../design/place-issues.js");
      const inv = await resolveInventory(resolved);
      const kit = inv.kits[0];
      if (kit) {
        const run = await placeNewIssues(resolved, merged.backlog, inv, {
          model: str(parsed.flags.model),
          limit: num(parsed.flags["max-placements"]),
        });
        if (run.placed > 0 || run.skipped > 0) {
          await saveBacklog(resolved, merged.backlog);
          backlogNote +=
            `; placement: ${run.placed} issue(s) located in ${kit.name}` +
            (run.skipped > 0 ? `, ${run.skipped} left for the next run` : "");
        }
      }
    }
  }

  // One image showing everything judged, with the tiles that carry findings
  // marked. A session driving lookout should be able to see what lookout saw
  // without spending more of its context on screenshots than on the findings.
  const findingsByShot = new Map<string, number>();
  for (const f of outcome.findings) {
    findingsByShot.set(f.shotId, (findingsByShot.get(f.shotId) ?? 0) + 1);
  }
  const sheet = await runContactSheet(resolved, [...shotsById.values()], findingsByShot);
  outcome.contactSheet = sheet?.path ?? null;

  if (parsed.flags.json) {
    printJson(outcome);
  } else {
    console.log(
      `\n${outcome.shotsConsidered} shot(s): ${outcome.judged} judged, ${outcome.cached} cached` +
        // Said out loud, because a shot nobody ruled on is not a clean shot and
        // the difference is invisible in a finding count.
        (outcome.unjudged > 0 ? `, ${outcome.unjudged} NOT judged` : "") +
        `; ${outcome.findings.length} finding(s), ${outcome.refuted.length} refuted; ` +
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
    if (backlogNote) console.log(backlogNote);
    if (sheet) console.log(`\n${sheetNote(sheet)}`);
  }
  emit("run-end", `${outcome.findings.length} finding(s); ~$${outcome.costUsd}`, {
    findings: outcome.findings.length,
    costUsd: outcome.costUsd,
  });
  setCurrentLog(null);
  return outcome.findings.length > 0 || outcome.deterministicErrors > 0 ? 1 : 0;
}
