/**
 * Ruling on a fix to a defect that was never visual.
 *
 * Some findings come from reading source rather than pixels: a hand-rolled
 * control where the kit has a component, a token used raw. Re-capturing proves
 * nothing about those, because the screen can look identical either way and the
 * whole point of the finding is what the code says. So they are ruled by
 * re-reading the code, and this is the path that does it, kept apart from the
 * visual one because sharing a function between two verdicts reached from two
 * different kinds of evidence is how a rule ends up applying to the wrong one.
 */
import { setStatus, type Backlog } from "../backlog/lib.js";
import { saveBacklog } from "../verbs/backlog.js";
import { loadState, saveState } from "../fix/state.js";
import { ruleCodeCluster } from "../fix/rule-code.js";
import { ruleVerdict, type Verdict } from "../fix/rule.js";
import { emit } from "../report/events.js";
import { nowIso, printJson, runId as makeRunId } from "../util.js";
import type { FixCluster } from "../fix/cluster.js";
import type { ResolvedConfig } from "../types.js";

/**
 * Rule on a source finding, and record it the same way the visual path does.
 *
 * The bookkeeping is deliberately identical: same statuses, same attempt
 * accounting, same exit codes, same state file. What differs is only the
 * oracle, because the question differs. A caller cannot tell from the outside
 * which path ran, which is the point: an issue is an issue.
 */
export async function ruleCodeIssue(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  before: Backlog,
  opts: {
    attempt: number;
    maxAttempts: number;
    issueId: string;
    commit: string | null;
    note: string | null;
    json: boolean;
  },
): Promise<number> {
  const { attempt, maxAttempts, issueId } = opts;
  const runIdNow = makeRunId("verify-fix");

  emit("phase", `re-reading the source for issue ${issueId}`, { issue: issueId, phase: "scan" });
  const ruling = await ruleCodeCluster(resolved, cluster);

  // No unchanged-pixels guard here, and none is needed: the scanner is
  // deterministic, so an unchanged file gives an unchanged answer. If the
  // finding is gone, the source really changed.
  const verdict: Verdict = ruleVerdict({
    attempt,
    maxAttempts,
    // Deterministic re-read, so "did anything change" is not a question the
    // verdict has to hedge on. Claiming one changed file keeps the shared
    // rule function honest without inventing a screenshot count.
    changedShots: 1,
    stillOpen: ruling.stillOpen,
    unmetCriteria: 0,
  });

  const backlog = before;
  if (verdict === "passed") {
    for (const fp of cluster.fingerprints) {
      if (backlog.findings[fp]) {
        setStatus(backlog, fp, "fixed", { commit: opts.commit ?? undefined, runId: runIdNow, now: nowIso() });
      }
    }
    // The criteria were written to be decidable by this same scan, so the scan
    // clearing is what meets them.
    const record = backlog.issues?.[issueId];
    if (record?.acceptance) {
      for (const c of record.acceptance) {
        c.verdict = "met";
        c.ruledAt = nowIso();
        c.runId = runIdNow;
      }
    }
  } else if (verdict === "blocked") {
    const reason =
      `${attempt} fix attempt(s) did not clear this. ` +
      (ruling.note ? `The source scan still sees: ${ruling.note}` : "The duplicate persists.") +
      (opts.note ? ` Last attempt reported: ${opts.note}` : "");
    for (const fp of cluster.fingerprints) {
      if (backlog.findings[fp]) {
        setStatus(backlog, fp, "blocked", { reason, runId: runIdNow, now: nowIso() });
      }
    }
  } else {
    for (const fp of cluster.fingerprints) {
      const f = backlog.findings[fp];
      if (f) f.fixAttempts += 1;
    }
  }
  await saveBacklog(resolved, backlog);

  const state = await loadState(resolved, issueId);
  state.attempts.push({
    n: attempt,
    dispatchedAt: nowIso(),
    ...(opts.commit || opts.note
      ? {
          reported: {
            ...(opts.commit ? { commit: opts.commit } : {}),
            ...(opts.note ? { note: opts.note } : {}),
          },
        }
      : {}),
    verdict,
    ...(ruling.note ? { judgeNote: ruling.note } : {}),
  });
  await saveState(resolved, state);

  emit(
    "verdict",
    `${issueId}: ${verdict} (attempt ${attempt} of ${maxAttempts})`,
    { issue: issueId, verdict, attempt, maxAttempts, judgeNote: ruling.note },
    verdict === "passed" ? "info" : "error",
  );

  const exit = verdict === "passed" ? 0 : verdict === "blocked" ? 3 : 1;
  if (opts.json) {
    printJson({
      issue: issueId,
      verdict,
      channel: "code",
      attempt,
      maxAttempts,
      ruledBy: "source scan",
      stillOpen: ruling.stillOpen,
      note: ruling.note,
      exit,
    });
  } else {
    console.log(
      `\n${issueId}: ${verdict} (attempt ${attempt} of ${maxAttempts}), ruled by re-reading the source`,
    );
    if (ruling.note) console.log(`  ${ruling.note}`);
    if (verdict === "passed") console.log("  the source scan no longer sees this duplicate");
  }
  return exit;
}
