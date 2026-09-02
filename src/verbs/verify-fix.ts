/**
 * `lookout verify-fix --issue <id>`: the oracle's ruling on a claimed fix.
 *
 * A fix session never grades its own work. It edits, commits, and reports; this
 * verb re-captures the cluster's own routes, re-judges them, and decides. The
 * view-group judge cache is what makes that trustworthy: a scoped re-check
 * re-judges a whole view rather than the single shot whose pixels moved, so a
 * comparative finding cannot vanish just because its partner was cached.
 *
 * Exit codes are the calling session's branch:
 *   0  passed     the defect is gone, the backlog is adjudicated, move on
 *   1  not fixed  the finding stays open, with a note on what the judge sees now
 *   2  error      lookout could not run
 *   3  blocked    attempts exhausted; it needs a person
 */
import { loadConfig } from "../config.js";
import { clusterKeyOf, clusterScope, configuredRoutesOf } from "../fix/cluster.js";
import { findIssue, issueById } from "../issues/registry.js";
import { issueDocPath } from "../issues/paths.js";
import { spawnedIssues, stampCausedBy } from "../issues/spawned.js";
import { attemptRecord, headSha, judgeNoteFor, narrowingFlags, observeRepo, previousAttempt, recordAttempt } from "../verify/attempt.js";
import { ruleCodeIssue } from "../verify/code.js";
import { loadIssueBaseline, rulingBaselineOf } from "../verify/baseline.js";
import { unclosableMembers } from "../verify/closure.js";

// Re-exported from their new home so existing importers keep working; the
// implementations moved to src/verify/ to fix the verify -> verbs import
// inversion.
export { baselineHashes, withoutByDesign } from "../verify/evidence.js";
import { ruleIssueAcceptance, unruledJudgeCriteria } from "../verify/acceptance.js";
import { fixPayload, printFixOutcome, type FixOutcomeArgs } from "../verify/outcome-report.js";
import { gatherFreshEvidence } from "../verify/evidence.js";
import { ruleVerdict, type Verdict } from "../fix/rule.js";
import { setStatus, type Backlog } from "../backlog/lib.js";
import { loadReport } from "../capture/store.js";
import { loadBacklog, saveBacklog } from "./backlog.js";
import { DEFAULT_MAX_ATTEMPTS } from "./check.js";
import { ensureBeforeFrames, freezeFrames } from "../issues/frames.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { nowIso, num, printJson, runId as makeRunId, str, type Parsed } from "../util.js";
import { emit, EventLog, setCurrentLog } from "../report/events.js";

/**
 * The answer when nothing is open under this id.
 *
 * These cases used to share one: "passed", exit 0. That made the verb an
 * orchestrating session gates on lie in the two places it must not. An id
 * lookout has never heard of, a typo or one carried over from another project,
 * read as a fix confirmed, so the session moved on from work nothing had
 * verified. And an issue already ruled blocked reported success rather than the
 * exit 3 that exists to stop it being dispatched again.
 */
export function noOpenWork(
  backlog: Backlog,
  issueId: string,
  json = false,
  resolved?: ResolvedConfig,
): number {
  const record = issueById(backlog, issueId);
  if (!record) {
    throw new LookoutError(
      `no issue "${issueId}" in this backlog`,
      "ids come from `lookout status`, `lookout ui`, or the folders under .lookout/issues/",
    );
  }

  const members = Object.values(backlog.findings).filter((f) => clusterKeyOf(f) === record.key);
  if (members.length === 0) {
    throw new LookoutError(
      `issue ${issueId} has no findings`,
      "its id outlived the findings it was minted for; run `lookout backlog check`",
    );
  }

  const blocked = members.filter((m) => m.status === "blocked");
  if (blocked.length > 0) {
    const reason = blocked.find((m) => m.reason)?.reason ?? "attempts were exhausted";
    // The way forward, as facts: what reopens it, and where every attempt so
    // far is written down. A blocked issue used to end here with no path.
    const reopen = `lookout backlog set --issue ${issueId} --status open`;
    const next = `this one needs a person; stop dispatching it. \`${reopen}\` reopens it`;
    const doc = resolved ? issueDocPath(resolved, issueId) : null;
    if (json) {
      printJson({ issue: issueId, verdict: "blocked", reason, next, reopen, doc });
    } else {
      console.log(`${issueId}: blocked\n  ${reason}\n  ${next}` + (doc ? `\n  every attempt is recorded in ${doc}` : ""));
    }
    return 3;
  }

  // Everything here is already fixed or ruled by-design. That is a clean answer,
  // but it is not a fix THIS run verified, and calling it "passed" would let a
  // session record a verification that never happened.
  const statuses = [...new Set(members.map((m) => m.status))].sort();
  const next = "nothing to verify; this issue was closed before this run";
  if (json) {
    printJson({ issue: issueId, verdict: "already-adjudicated", statuses, next });
  } else {
    console.log(`${issueId}: already adjudicated (${statuses.join(", ")})\n  ${next}`);
  }
  return 0;
}

export async function verifyFix(parsed: Parsed): Promise<number> {
  const issueId = str(parsed.flags.issue) ?? parsed.positionals[0];
  if (!issueId) {
    throw new LookoutError("verify-fix needs --issue <id>", "ids come from `lookout status` or the UI");
  }
  const maxAttempts = num(parsed.flags["max-attempts"]) ?? DEFAULT_MAX_ATTEMPTS;
  // Two flags make a ruling meaningless rather than narrow: one rules on the
  // last capture instead of a fresh one, the other rules every accessibility
  // criterion met without running the check. Refused before anything runs.
  if (parsed.flags["no-capture"]) {
    throw new LookoutError("verify-fix cannot rule with --no-capture", "a ruling on stale pixels is not a ruling; drop the flag");
  }
  if (str(parsed.flags.axe) === "off") {
    throw new LookoutError("verify-fix cannot rule with --axe off", "every accessibility criterion would be met without the check running; drop the flag");
  }
  // Same reasoning: a clipped-content criterion is ruled by whether the check
  // fires on the fresh capture, so silencing the check would rule every one of
  // them met without measuring anything.
  if (parsed.flags["no-edge-clip"]) {
    throw new LookoutError(
      "verify-fix cannot rule with --no-edge-clip",
      "every clipped-content criterion would be met without the check running; drop the flag",
    );
  }

  const preResolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
  });
  const elog = new EventLog(preResolved, makeRunId("verify-fix"));
  // Join, never start: this run rules on one issue of a board another run
  // defined, and truncating here would erase every other issue's narration.
  elog.join(`lookout verify-fix ${issueId}`, { issue: issueId, verb: "verify-fix" });
  setCurrentLog(elog);
  const before = await loadBacklog(preResolved);
  // No attempt cap here: an issue at its cap must still be findable, because
  // ruling it blocked is this verb's job.
  const cluster = findIssue(before, issueId, { statuses: ["open"] });
  if (!cluster) {
    // Nothing open under this id, which is four different answers rather than
    // the one "passed" they used to share.
    const code = noOpenWork(before, issueId, !!parsed.flags.json, preResolved);
    setCurrentLog(null);
    return code;
  }

  const attempt = cluster.attemptsSpent + 1;
  // What the fixer says they did. Read once, before the paths diverge: both
  // the visual and the source ruling record it the same way.
  const reportedCommit = str(parsed.flags.commit) ?? (await headSha(preResolved.projectDir));
  const reportedNote = str(parsed.flags.note);

  // A source finding is ruled by re-reading the source, not by re-photographing
  // the app. Branch before anything opens a browser: there are no routes to
  // re-capture for a defect that was never visible in a screenshot, and running
  // the whole capture pipeline to rule on one would burn minutes to learn
  // nothing.
  if (cluster.channel === "code") {
    const code = await ruleCodeIssue(preResolved, cluster, before, {
      attempt,
      maxAttempts,
      issueId,
      commit: reportedCommit ?? null,
      note: reportedNote ?? null,
      json: !!parsed.flags.json,
      model: str(parsed.flags.model) ?? null,
    });
    // Blocked statuses born on this ruling are learning evidence; the trigger
    // sees them now rather than waiting for the next check.
    {
      const { maybeAutoImprove } = await import("../skills/auto-improve.js");
      await maybeAutoImprove(preResolved, parsed, (line) => {
        if (!parsed.flags.json) console.log(line);
      });
    }
    setCurrentLog(null);
    return code;
  }

  // What the scope looked like BEFORE re-capturing. Everything below turns on
  // this: the judge is not deterministic, so re-judging the same pixels can
  // surface findings it did not mention last time and drop findings it did.
  // Pixel hashes are deterministic, and they are what separates "the fixer
  // changed something" from "the judge said something different today".
  const priorReport = await loadReport(preResolved);
  // The issue's own record first: the previous ruling's capture, then the
  // frames frozen at filing. The workspace is asked only for shots the issue
  // has no record of, because a check run since the edit has already moved it.
  const base = await loadIssueBaseline(preResolved, cluster, priorReport?.shots ?? [], Object.values(before.findings));
  const priorHashes = base.hashes;
  // A settle different from the filing capture's moves pixels for reasons
  // unrelated to the fix. Said, not refused: a slow render sometimes needs it.
  const filedSettle = priorReport?.runs.find((r) => cluster.members.some((m) => m.evidence[m.evidence.length - 1]?.runId === r.id))?.flags?.settleMs;
  const askedSettle = num(parsed.flags.settle);
  if (typeof filedSettle === "number" && askedSettle !== undefined && askedSettle !== filedSettle) {
    emit("note", `--settle ${askedSettle} differs from the ${filedSettle} the filing capture used; pixels may move for reasons unrelated to the fix`, { filedSettle, askedSettle });
  }

  // The last moment the defect still exists in a file. The capture below writes
  // each view back to the path it came from, so a frame not copied aside now is
  // a frame nothing can show afterwards. Normally the save that filed the issue
  // froze this already; what is left here is the backstop for an issue filed
  // before frames existed, and it defers to the same rule, so an issue that has
  // already spent an attempt is not handed a "before" of unknown vintage.
  await ensureBeforeFrames(preResolved, cluster);

  // 1. Re-capture and re-judge this cluster's own routes, fold the result into
  // the backlog, and work out what actually moved.
  const {
    resolved,
    outcome,
    shotsById,
    backlog,
    sheet,
    changedShots,
    baselineShots,
    freshDeterministic,
    stillOpen,
    runIdNow,
  } = await gatherFreshEvidence({
    parsed,
    issueId,
    cluster,
    priorHashes,
    configuredRoutes: configuredRoutesOf(preResolved.config, cluster.target),
  });

  // 3. Rule this issue's acceptance criteria against the fresh evidence, each
  // source ruled by the thing that can actually decide it.
  const { criteria: ruledCriteria, unmet, costUsd: acceptanceCost } = await ruleIssueAcceptance({
    resolved,
    parsed,
    backlog,
    issueId,
    cluster,
    shotsById,
    changedShots,
    baselineShots,
    freshDeterministic,
    runIdNow,
  });

  // 4. Rule.
  //
  // The load-bearing guard: nothing may PASS on unchanged pixels. If every
  // screenshot in the scope is byte-identical to the previous run, no change
  // reached the rendered output, so a cluster whose findings happen to be
  // absent this time was not fixed, it was judged differently. Passing there
  // would let judge variance alone close real defects, which would make the
  // oracle worthless precisely where it is supposed to be strict.
  const nothingChanged = changedShots.size === 0;
  // Closure is per member, backed by that member's own pixels. The scope
  // changing somewhere is not enough: a multi-route cluster would otherwise
  // close members whose views were served from cache while a sibling route
  // moved, which is judge variance laundered through the ledger.
  const unclosable = unclosableMembers(cluster, changedShots);
  const verdict: Verdict = ruleVerdict({
    attempt,
    maxAttempts,
    changedShots: changedShots.size,
    stillOpen: stillOpen.length,
    unmetCriteria: unmet.length,
    unclosableMembers: unclosable.length,
  });

  // A pass may not rest on unruled acceptance. If the verdict would be
  // "passed" while judge-authored criteria are pending or carry another run's
  // ruling, the acceptance verifier did not do its job THIS attempt, and
  // "passed" would print with zero criteria actually checked. That is an
  // infrastructure failure, not a fix failure: exit 2, nothing closes, and no
  // attempt is recorded, so a dying verifier cannot walk a fixer to blocked.
  const unruled = unruledJudgeCriteria(ruledCriteria, runIdNow);
  if (verdict === "passed" && unruled.length > 0) {
    await saveBacklog(resolved, backlog);
    const what =
      `the defect looks gone, but ${unruled.length} acceptance criteri` +
      `${unruled.length === 1 ? "on was" : "a were"} never ruled this run; no attempt was spent, re-run verify-fix`;
    emit("verdict", `${issueId}: not-ruled (${what})`, { issue: issueId, verdict: "not-ruled" }, "error");
    if (parsed.flags.json) {
      printJson({ issue: issueId, verdict: "not-ruled", unruled: unruled.map((c) => c.text), exit: 2 });
    } else {
      console.log(`
${issueId}: not ruled. ${what}`);
      for (const c of unruled) console.log(`  - ${c.text}`);
    }
    setCurrentLog(null);
    return 2;
  }

  const judgeNote = judgeNoteFor({
    nothingChanged,
    baselineShots,
    totalShots: shotsById.size,
    stillOpen,
    unmet,
    unclosable,
  });

  // A defect this fix caused somewhere else is a NEW issue, with its own number
  // and its own evidence. It is not this one regressing, and charging it here
  // is what used to block issues whose defect had actually been fixed.
  //
  // The merge already filed it; what is added here is where it came from. A
  // finding on a screenshot whose pixels did not move cannot have been caused
  // by anything, so those are filed like any other finding and left unstamped:
  // that is the judge reading the same image differently today.
  const spawned = spawnedIssues(before, backlog, changedShots, cluster.id);
  const caused = stampCausedBy(backlog, spawned, {
    issue: cluster.id,
    commit: reportedCommit ?? null,
    runId: runIdNow,
    at: nowIso(),
  });

  if (verdict === "passed") {
    // The only moment lookout is willing to say this screen is fixed, and
    // therefore the only frame worth keeping as the after.
    await freezeFrames(resolved, cluster, "after");
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
    // Another round: spend the attempt. The judge note recorded with it
    // carries what the judge sees NOW rather than what it saw when the issue
    // was first filed.
    for (const fp of cluster.fingerprints) {
      const f = backlog.findings[fp];
      if (f) f.fixAttempts += 1;
    }
  }
  // 5. Record the attempt, then save. The save rewrites the issue's document,
  // and the document reads the attempts: written the other way round, the
  // document regenerated by this ruling could never carry the ruling.
  const previous = await previousAttempt(resolved, issueId);
  const observed = await observeRepo(resolved.projectDir, previous?.reported?.commit, reportedCommit);
  const stillOpenRecorded = stillOpen.map((f) => ({ title: f.title, shotId: f.evidence[0]?.shotId ?? "", observed: f.observed }));
  const unclosableRoutes = [...new Set(unclosable.map((m) => m.route))];
  await recordAttempt(
    resolved,
    issueId,
    attemptRecord({
      n: attempt,
      commit: reportedCommit,
      note: reportedNote,
      verdict,
      judgeNote,
      spawned: caused,
      runId: runIdNow,
      totalShots: shotsById.size,
      changedShots: changedShots.size,
      baselineShots,
      stillOpen: stillOpenRecorded,
      unclosable: unclosableRoutes,
      criteria: ruledCriteria.map((c) => ({ id: c.id, text: c.text, verdict: c.verdict, ...(c.note ? { note: c.note } : {}) })),
      contactSheet: sheet?.path ?? null,
      flags: narrowingFlags(parsed.flags),
      observed,
      baseline: base.described,
    }),
    rulingBaselineOf(shotsById),
  );
  await saveBacklog(resolved, backlog);

  emit(
    "verdict",
    `${issueId}: ${verdict} (attempt ${attempt} of ${maxAttempts})`,
    { issue: issueId, verdict, attempt, maxAttempts, judgeNote },
    verdict === "passed" ? "info" : "error",
  );
  const exit = verdict === "passed" ? 0 : verdict === "blocked" ? 3 : 1;
  // The learning trigger, before the payload so --json carries what it did.
  // The exit code above is already decided: an improve failure is an
  // incident, never this verdict's problem.
  const { maybeAutoImprove } = await import("../skills/auto-improve.js");
  const learned = await maybeAutoImprove(resolved, parsed, (line) => {
    if (!parsed.flags.json) console.log(line);
  });
  // The same facts the document just took: a session reading stdout and one
  // opening the file fresh learn the same things about this attempt.
  const outcomeArgs: FixOutcomeArgs = {
    issueId,
    verdict,
    attempt,
    maxAttempts,
    judgeNote,
    ruledCriteria,
    spawned,
    sheet,
    stillOpen: stillOpenRecorded,
    changedShots: changedShots.size,
    baselineShots,
    totalShots: shotsById.size,
    unclosable: unclosableRoutes,
    reportedCommit: reportedCommit ?? null,
    reportedNote: reportedNote ?? null,
    observed,
    docPath: issueDocPath(resolved, issueId),
    baseline: base.described,
    photographed: {
      url: resolved.config.targets.find((t) => t.name === cluster.target)?.url ?? null,
      routes: clusterScope(cluster, configuredRoutesOf(resolved.config, cluster.target)).routes,
    },
    flags: parsed.flags,
    costUsd: (outcome.costUsd ?? 0) + acceptanceCost,
    ...(learned.ran || learned.skipped !== undefined ? { learned } : {}),
  };
  printFixOutcome({ ...outcomeArgs, json: !!parsed.flags.json, payload: fixPayload(outcomeArgs) });
  emit("run-end", `${issueId}: ${verdict}`, { verdict });
  setCurrentLog(null);
  return exit;
}
