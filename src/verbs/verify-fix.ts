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
import { clusterKeyOf, clusterScope } from "../fix/cluster.js";
import { findIssue, issueById } from "../issues/registry.js";
import { spawnedIssues, stampCausedBy } from "../issues/spawned.js";
import { loadState, saveState } from "../fix/state.js";
import { acceptanceTally, blocksPass } from "../issues/acceptance.js";
import {
  asCriteriaText,
  judgeableCriteria,
  matchJudged,
  ruleAcceptance,
  type JudgedCriterion,
} from "../issues/rule-acceptance.js";
import { MAX_VERIFY_SHOTS, verifyCriteria } from "../judge/criteria.js";
import { loadSkill } from "../skills/load.js";
import { evidenceDir } from "../config.js";
import { ruleVerdict, type Verdict } from "../fix/rule.js";
import {
  aiToFindings,
  deterministicToFindings,
  setStatus,
  type Backlog,
  type BacklogFinding,
} from "../backlog/lib.js";
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
export function noOpenWork(backlog: Backlog, issueId: string, json = false): number {
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
    const next = "this one needs a person; stop dispatching it";
    if (json) {
      printJson({ issue: issueId, verdict: "blocked", reason, next });
    } else {
      console.log(`${issueId}: blocked\n  ${reason}\n  ${next}`);
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

/**
 * Every shot lookout holds a previous hash for, from either source.
 *
 * `.lookout/evidence/` is gitignored and routinely cleaned, and an empty
 * baseline made every fresh shot look changed, which switched the pixels-moved
 * guard OFF exactly when it was needed: a wiped evidence directory would let
 * judge variance alone pass an issue. backlog.json is committed and its evidence
 * refs carry the hash each finding was filed against, so they outlive the
 * pixels. The report is fresher, so it wins where both know a shot.
 */
export function baselineHashes(
  priorShots: readonly { id: string; hash: string }[],
  findings: readonly BacklogFinding[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of findings) {
    // Later refs win: evidence is appended in capture order.
    for (const ev of f.evidence) out.set(ev.shotId, ev.hash);
  }
  for (const sh of priorShots) out.set(sh.id, sh.hash);
  return out;
}

/**
 * Drop findings somebody already ruled intentional.
 *
 * A by-design sibling under an issue's own cluster key re-fires on every
 * capture, because an intentional defect is still there by definition. Counting
 * it held the issue open however well the real defect had been fixed, and then
 * blocked it with a reason claiming a defect persists that somebody had already
 * ruled intended. `mergeFindings` suppresses these; the verdict has to as well.
 */
export function withoutByDesign<T extends { fingerprint: string }>(
  fresh: readonly T[],
  backlog: Backlog,
): T[] {
  const byDesign = new Set(
    Object.values(backlog.findings)
      .filter((f) => f.status === "by-design")
      .map((f) => f.fingerprint),
  );
  return fresh.filter((f) => !byDesign.has(f.fingerprint));
}

export async function verifyFix(parsed: Parsed): Promise<number> {
  const issueId = str(parsed.flags.issue) ?? parsed.positionals[0];
  if (!issueId) {
    throw new LookoutError("verify-fix needs --issue <id>", "ids come from `lookout status` or the UI");
  }
  const maxAttempts = num(parsed.flags["max-attempts"]) ?? DEFAULT_MAX_ATTEMPTS;

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
    const code = noOpenWork(before, issueId, !!parsed.flags.json);
    setCurrentLog(null);
    return code;
  }

  const attempt = cluster.attemptsSpent + 1;

  // What the scope looked like BEFORE re-capturing. Everything below turns on
  // this: the judge is not deterministic, so re-judging the same pixels can
  // surface findings it did not mention last time and drop findings it did.
  // Pixel hashes are deterministic, and they are what separates "the fixer
  // changed something" from "the judge said something different today".
  const priorReport = await loadReport(preResolved);
  const priorHashes = baselineHashes(priorReport?.shots ?? [], Object.values(before.findings));
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

  // The session reading this verdict should be able to see the state it was
  // reached from, so composite what was just re-captured, with the tiles that
  // still carry findings marked.
  const freshByShot = new Map<string, number>();
  for (const f of outcome.findings) freshByShot.set(f.shotId, (freshByShot.get(f.shotId) ?? 0) + 1);
  const sheet = await runContactSheet(
    resolved,
    [...shotsById.values()],
    freshByShot,
    `verify-${issueId}.png`,
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
  // A shot with no baseline at all is not evidence of change: it is evidence of
  // nothing. Counting it as changed is what let a cleaned evidence directory
  // satisfy the guard. Kept separate so the verdict and the criterion can both
  // say which of the two they are looking at.
  const changedShots = new Set<string>();
  const noBaseline = new Set<string>();
  for (const sh of shotsById.values()) {
    const prior = priorHashes.get(sh.id);
    if (prior === undefined) noBaseline.add(sh.id);
    else if (prior !== sh.hash) changedShots.add(sh.id);
  }
  const baselineShots = shotsById.size - noBaseline.size;

  const freshDeterministic = report
    ? deterministicToFindings({
        ...report,
        shots: report.shots.filter((sh) => latestShots.has(sh.id) && shotsById.has(sh.id)),
      })
    : [];
  const fresh = [...aiToFindings(outcome.findings, shotsById), ...freshDeterministic];
  const backlog = merged.backlog;
  const stillOpen = withoutByDesign(
    fresh.filter((f) => clusterKeyOf(f) === cluster.key),
    backlog,
  );
  const runIdNow = outcome.runId;

  // 3. Rule this issue's acceptance criteria against the fresh evidence.
  //
  // Each source is ruled by the thing that can decide it: the deterministic
  // checks rule their own, the pixel hashes rule the re-capture guard, and the
  // judge-authored ones get an independent look at the new screenshots rather
  // than being inferred from whether the original finding came back.
  const record = backlog.issues?.[issueId];
  const criteria = record?.acceptance ?? [];
  const judgeable = judgeableCriteria(criteria);
  let judged = new Map<string, JudgedCriterion>();
  let acceptanceCost = 0;

  if (judgeable.length > 0) {
    // The issue's own views, capped: these criteria are about this defect, and
    // the verifier needs the whole evidence set in one context.
    const ownShotIds = new Set(
      cluster.members.flatMap((m) => m.evidence.map((e) => e.shotId)),
    );
    const forCriteria = [...shotsById.values()]
      .filter((sh) => ownShotIds.has(sh.id))
      .slice(0, MAX_VERIFY_SHOTS);
    const shotsForCriteria =
      forCriteria.length > 0 ? forCriteria : [...shotsById.values()].slice(0, MAX_VERIFY_SHOTS);
    try {
      const skill = await loadSkill(resolved, "verify-acceptance");
      const result = await verifyCriteria(
        skill.text,
        resolved.project,
        asCriteriaText(judgeable),
        shotsForCriteria,
        evidenceDir(resolved),
        str(parsed.flags.model) ?? "sonnet",
      );
      judged = matchJudged(judgeable, result.criteria);
      acceptanceCost = result.costUsd ?? 0;
    } catch (e) {
      // A verifier that could not run leaves those criteria unruled rather than
      // failing the issue: `stillOpen` is the primary gate, and an unreachable
      // criterion is not evidence of anything.
      emit("error", `acceptance criteria could not be ruled: ${(e as Error).message}`, {}, "error");
    }
  }

  const freshFingerprints = new Set(freshDeterministic.map((f) => f.fingerprint));
  const recapturedFingerprints = new Set(
    criteria
      .map((c) => c.from)
      .filter((fp): fp is string => !!fp)
      .filter((fp) =>
        (backlog.findings[fp]?.evidence ?? []).some((e) => shotsById.has(e.shotId)),
      ),
  );
  const ruledCriteria = ruleAcceptance({
    criteria,
    changedShots: changedShots.size,
    totalShots: shotsById.size,
    baselineShots,
    deterministic: { freshFingerprints, recapturedFingerprints },
    judged,
    ruledAt: nowIso(),
    runId: runIdNow,
  });
  if (record) record.acceptance = ruledCriteria;
  const unmet = blocksPass(ruledCriteria);

  // 4. Rule.
  //
  // The load-bearing guard: nothing may PASS on unchanged pixels. If every
  // screenshot in the scope is byte-identical to the previous run, no change
  // reached the rendered output, so a cluster whose findings happen to be
  // absent this time was not fixed, it was judged differently. Passing there
  // would let judge variance alone close real defects, which would make the
  // oracle worthless precisely where it is supposed to be strict.
  const nothingChanged = changedShots.size === 0;
  const verdict: Verdict = ruleVerdict({
    attempt,
    maxAttempts,
    changedShots: changedShots.size,
    stillOpen: stillOpen.length,
    unmetCriteria: unmet.length,
  });

  const judgeNote = nothingChanged
    ? baselineShots === 0
      ? `no baseline: none of the ${shotsById.size} screenshot(s) in this scope have a previous ` +
        "capture to compare against, so lookout cannot tell whether the fix reached the rendered " +
        "output. Run `lookout check` on this scope first, then verify."
      : `nothing changed: all ${baselineShots} comparable screenshot(s) in this scope are ` +
        "byte-identical to the previous run, so no edit reached the rendered output. Either the fix " +
        "was not applied, it was applied somewhere the app does not use, or the app was not rebuilt."
    : stillOpen.length > 0
      ? stillOpen[0]!.observed
      : unmet.length > 0
        ? `${unmet.length} acceptance criteri${unmet.length === 1 ? "on" : "a"} still fail: ` +
          unmet.map((c) => c.text).join("; ")
        : "";

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
  await saveBacklog(resolved, backlog);

  // 5. Record the attempt.
  const state = await loadState(resolved, issueId);
  state.attempts.push({
    n: attempt,
    dispatchedAt: nowIso(),
    ...(reportedCommit || reportedNote
      ? { reported: { ...(reportedCommit ? { commit: reportedCommit } : {}), ...(reportedNote ? { note: reportedNote } : {}) } }
      : {}),
    verdict,
    ...(judgeNote ? { judgeNote } : {}),
    ...(caused.length > 0 ? { spawned: caused } : {}),
  });
  await saveState(resolved, state);

  emit(
    "verdict",
    `${issueId}: ${verdict} (attempt ${attempt} of ${maxAttempts})`,
    { issue: issueId, verdict, attempt, maxAttempts, judgeNote },
    verdict === "passed" ? "info" : "error",
  );
  const exit = verdict === "passed" ? 0 : verdict === "blocked" ? 3 : 1;
  const payload = {
    issue: issueId,
    verdict,
    attempt,
    maxAttempts,
    stillOpen: stillOpen.map((f) => f.title),
    changedShots: changedShots.size,
    baselineShots,
    // New issues this run filed. Separate work, with their own numbers; this
    // issue's verdict does not turn on them.
    spawned: spawned.map((s) => ({
      issue: s.issue.id,
      title: s.issue.title,
      severity: s.issue.severity,
      causedByThisFix: s.causedByThisFix,
    })),
    judgeNote: judgeNote || null,
    acceptance: ruledCriteria.map((c) => ({
      id: c.id,
      text: c.text,
      source: c.source,
      verdict: c.verdict,
      note: c.note ?? null,
    })),
    commit: reportedCommit ?? null,
    next:
      (verdict === "passed"
        ? "confirmed and adjudicated; the finding is closed"
        : verdict === "blocked"
          ? "attempts exhausted; this one needs a person"
          : "the defect is still there; the finding stays open") +
      (spawned.length > 0
        ? `. ${spawned.length} new issue(s) were filed in this run (${spawned
            .map((s) => s.issue.id)
            .join(", ")}); they are separate work`
        : ""),
    costUsd: (outcome.costUsd ?? 0) + acceptanceCost,
    contactSheet: sheet?.path ?? null,
  };

  if (parsed.flags.json) {
    printJson(payload);
  } else {
    console.log(
      `\n${issueId}: ${verdict} (attempt ${attempt} of ${maxAttempts})` +
        (judgeNote ? `\n  judge: ${judgeNote}` : "") +
        `\n  ${payload.next}`,
    );
    const tally = acceptanceTally(ruledCriteria);
    if (tally.total > 0) {
      console.log(`  acceptance: ${tally.met}/${tally.total} met` +
        (tally.unmet ? `, ${tally.unmet} failing` : "") +
        (tally.notVerifiable ? `, ${tally.notVerifiable} not verifiable` : "") +
        (tally.pending ? `, ${tally.pending} not checked` : ""));
      for (const c of ruledCriteria) {
        const mark = c.verdict === "met" ? "x" : c.verdict === "unmet" ? " " : c.verdict === "not-verifiable" ? "-" : "?";
        console.log(`    [${mark}] ${c.text}`);
      }
    }
    for (const s of spawned) {
      console.log(
        `  new issue ${s.issue.id}: ${s.issue.title} (${s.issue.severity})` +
          (s.causedByThisFix ? ", on pixels this fix moved" : ""),
      );
    }
    if (sheet) console.log(`\n${sheetNote(sheet)}`);
  }
  emit("run-end", `${issueId}: ${verdict}`, { verdict });
  setCurrentLog(null);
  return exit;
}
