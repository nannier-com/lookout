/**
 * `lookout verify-fix --cluster <id>`: the oracle's ruling on a claimed fix.
 *
 * A fix session never grades its own work. It edits, commits, and reports; this
 * verb re-captures the cluster's own routes, re-judges them, and decides. The
 * view-group judge cache is what makes that trustworthy: a scoped re-check
 * re-judges a whole view rather than the single shot whose pixels moved, so a
 * comparative finding cannot vanish just because its partner was cached.
 *
 * Exit codes are the orchestrating session's branch:
 *   0  passed     the defect is gone, the backlog is adjudicated, move on
 *   1  not fixed  a fresh brief is written; dispatch a NEW session on it
 *   2  error      lookout could not run
 *   3  blocked    attempts exhausted; stop dispatching and report it
 */
import { loadConfig } from "../config.js";
import { clusterFindings, clusterIdOf, clusterScope, type FixCluster } from "../fix/cluster.js";
import { writeBrief } from "../fix/plan.js";
import { loadState, saveState, type Verdict } from "../fix/state.js";
import { aiToFindings, deterministicToFindings, setStatus, type Backlog } from "../backlog/lib.js";
import { loadReport } from "../capture/store.js";
import { loadBacklog, mergeLatest, saveBacklog } from "./backlog.js";
import { runCheck, DEFAULT_MAX_ATTEMPTS } from "./check.js";
import { runContactSheet } from "./capture.js";
import { sheetNote } from "../capture/sheet.js";
import { LookoutError } from "../types.js";
import { execFileAsync, nowIso, num, printJson, runId as makeRunId, str, type Parsed } from "../util.js";
import { emit, EventLog, setCurrentLog } from "../report/events.js";

/** HEAD of the target repository, when it is a git checkout. */
async function headSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function findCluster(backlog: Backlog, id: string): FixCluster | undefined {
  // No attempt cap here: a cluster at its cap must still be findable, because
  // ruling it blocked is this verb's job.
  return clusterFindings(Object.values(backlog.findings), { statuses: ["open"] }).find(
    (c) => c.id === id,
  );
}

export async function verifyFix(parsed: Parsed): Promise<number> {
  const clusterId = str(parsed.flags.cluster) ?? parsed.positionals[0];
  if (!clusterId) {
    throw new LookoutError("verify-fix needs --cluster <id>", "ids come from `lookout check --auto`");
  }
  const maxAttempts = num(parsed.flags["max-attempts"]) ?? DEFAULT_MAX_ATTEMPTS;

  const preResolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
  });
  const elog = new EventLog(preResolved, makeRunId("verify-fix"));
  elog.start(`lookout verify-fix ${clusterId}`, { cluster: clusterId });
  setCurrentLog(elog);
  const before = await loadBacklog(preResolved);
  const cluster = findCluster(before, clusterId);
  if (!cluster) {
    // Nothing open under this id: either it was never dispatched, or an
    // earlier pass already closed it. Both mean there is no work left here.
    if (parsed.flags.json) {
      printJson({ cluster: clusterId, verdict: "passed", reason: "no open findings under this cluster" });
    } else {
      console.log(`${clusterId}: passed (no open findings under this cluster)`);
    }
    return 0;
  }

  const attempt = cluster.attemptsSpent + 1;
  const reportedCommit = str(parsed.flags.commit) ?? (await headSha(preResolved.projectDir));
  const reportedNote = str(parsed.flags.note);

  // 1. Re-capture and re-judge only this cluster's own routes.
  const scope = clusterScope(cluster);
  const { outcome, resolved, shotsById } = await runCheck({
    positionals: [],
    flags: {
      ...parsed.flags,
      targets: scope.targets.join(","),
      routes: scope.routes.join(","),
    },
  });

  // The session ruling on this should be able to see the state it is ruling
  // on, so composite what was just re-captured.
  const freshByShot = new Map<string, number>();
  for (const f of outcome.findings) freshByShot.set(f.shotId, (freshByShot.get(f.shotId) ?? 0) + 1);
  const sheet = await runContactSheet(
    resolved,
    [...shotsById.values()],
    freshByShot,
    `fix/${clusterId}.after.png`,
  );

  // 2. Fold the fresh evidence into the backlog, then read the answer off it.
  const merged = await mergeLatest(resolved, { judgeOutcome: outcome });

  // Both channels, or a deterministic cluster could never fail. Rule violations
  // (every axe finding) come back from capture, not from the judge, so
  // comparing against judged findings alone would pass an accessibility cluster
  // whose violations are all still firing.
  const report = await loadReport(resolved);
  const latestRun = report?.runs[report.runs.length - 1];
  const latestShots = new Set(
    (report?.shots ?? []).filter((sh) => sh.runId === latestRun?.id).map((sh) => sh.id),
  );
  const freshDeterministic = report
    ? deterministicToFindings({
        ...report,
        shots: report.shots.filter((sh) => latestShots.has(sh.id) && shotsById.has(sh.id)),
      })
    : [];
  const fresh = [...aiToFindings(outcome.findings, shotsById), ...freshDeterministic];
  const stillOpen = fresh.filter((f) => clusterIdOf(f) === clusterId);
  const regressions = fresh.filter(
    (f) =>
      clusterIdOf(f) !== clusterId &&
      (f.severity === "critical" || f.severity === "high") &&
      !before.findings[f.fingerprint],
  );

  // 3. Rule.
  let verdict: Verdict;
  if (stillOpen.length === 0 && regressions.length === 0) verdict = "passed";
  else if (attempt >= maxAttempts) verdict = "blocked";
  else if (regressions.length > 0) verdict = "regressed";
  else verdict = "still-open";

  const judgeNote =
    regressions.length > 0
      ? `the fix introduced ${regressions.length} new finding(s): ${regressions.map((r) => r.title).join("; ")}`
      : stillOpen.length > 0
        ? stillOpen[0]!.observed
        : "";

  const backlog = merged.backlog;
  const runIdNow = outcome.runId;
  let briefPathOut: string | null = null;

  if (verdict === "passed") {
    for (const fp of cluster.fingerprints) {
      if (backlog.findings[fp]) {
        setStatus(backlog, fp, "fixed", { commit: reportedCommit, runId: runIdNow, now: nowIso() });
      }
    }
  } else if (verdict === "blocked") {
    const reason =
      `${attempt} fix attempt(s) did not clear this. ` +
      (judgeNote ? `The judge still sees: ${judgeNote}` : "The defect persists.") +
      (reportedNote ? ` Last attempt reported: ${reportedNote}` : "");
    for (const fp of cluster.fingerprints) {
      if (backlog.findings[fp]) {
        setStatus(backlog, fp, "blocked", { reason, runId: runIdNow, now: nowIso() });
      }
    }
  } else {
    // Another round: spend the attempt, then rewrite the brief with what the
    // judge sees NOW rather than what it saw when the cluster was first filed.
    for (const fp of cluster.fingerprints) {
      const f = backlog.findings[fp];
      if (f) f.fixAttempts += 1;
    }
  }
  await saveBacklog(resolved, backlog);

  // 4. Record the attempt, and write the next brief when there is one.
  const state = await loadState(resolved, clusterId);
  state.attempts.push({
    n: attempt,
    dispatchedAt: nowIso(),
    ...(reportedCommit || reportedNote
      ? { reported: { ...(reportedCommit ? { commit: reportedCommit } : {}), ...(reportedNote ? { note: reportedNote } : {}) } }
      : {}),
    verdict,
    ...(judgeNote ? { judgeNote } : {}),
  });
  await saveState(resolved, state);

  if (verdict === "still-open" || verdict === "regressed") {
    const next = findCluster(backlog, clusterId);
    if (next) briefPathOut = await writeBrief(resolved, next, maxAttempts);
  }

  emit(
    "verdict",
    `${clusterId}: ${verdict} (attempt ${attempt} of ${maxAttempts})`,
    { cluster: clusterId, verdict, attempt, maxAttempts, judgeNote, brief: briefPathOut },
    verdict === "passed" ? "info" : "error",
  );
  const exit = verdict === "passed" ? 0 : verdict === "blocked" ? 3 : 1;
  const payload = {
    cluster: clusterId,
    verdict,
    attempt,
    maxAttempts,
    stillOpen: stillOpen.map((f) => f.title),
    regressions: regressions.map((f) => f.title),
    judgeNote: judgeNote || null,
    commit: reportedCommit ?? null,
    brief: briefPathOut,
    contactSheet: sheet?.path ?? null,
    next:
      verdict === "passed"
        ? "confirmed and adjudicated; move to the next cluster"
        : verdict === "blocked"
          ? "attempts exhausted; stop dispatching this cluster and report it"
          : "dispatch a NEW fix session on the brief above",
    costUsd: outcome.costUsd,
  };

  if (parsed.flags.json) {
    printJson(payload);
  } else {
    console.log(
      `\n${clusterId}: ${verdict} (attempt ${attempt} of ${maxAttempts})` +
        (judgeNote ? `\n  judge: ${judgeNote}` : "") +
        (briefPathOut ? `\n  next brief: ${briefPathOut}` : "") +
        `\n  ${payload.next}`,
    );
    if (sheet) console.log(`\n${sheetNote(sheet)}`);
  }
  emit("run-end", `${clusterId}: ${verdict}`, { verdict });
  setCurrentLog(null);
  return exit;
}
