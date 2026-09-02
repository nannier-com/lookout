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
import { CODE_RECAPTURE_CRITERION } from "../issues/acceptance.js";
import { saveBacklog } from "../verbs/backlog.js";
import { attemptRecord, recordAttempt } from "./attempt.js";
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
    /** Model for the conformance re-read, from `verify-fix --model`. */
    model?: string | null;
  },
): Promise<number> {
  const { attempt, maxAttempts, issueId } = opts;
  const runIdNow = makeRunId("verify-fix");

  emit("phase", `re-reading the source for issue ${issueId}`, { issue: issueId, phase: "scan" });
  const ruling = await ruleCodeCluster(resolved, cluster, opts.model ? { model: opts.model } : {});

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
    // Each criterion is ruled by what actually decided it, never blanket-met.
    // Judge-authored ones were written to be decidable by this same re-read;
    // the code universal is the re-read's own claim. Anything else on a code
    // issue (a legacy screenshot criterion, most likely) involves evidence
    // this pass never touched, and saying "met" there would check a box for a
    // capture that never happened.
    const record = backlog.issues?.[issueId];
    if (record?.acceptance) {
      for (const c of record.acceptance) {
        const ruledHere =
          c.source === "judge" || (c.source === "universal" && c.text === CODE_RECAPTURE_CRITERION);
        c.verdict = ruledHere ? "met" : "not-verifiable";
        c.note = ruledHere
          ? "ruled by re-reading the source"
          : "code-channel issue: no screenshot was involved in this ruling";
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
  // The attempt before the save: the save rewrites the document, and the
  // document reads the attempts.
  await recordAttempt(
    resolved,
    issueId,
    attemptRecord({ n: attempt, commit: opts.commit, note: opts.note, verdict, judgeNote: ruling.note }),
  );
  await saveBacklog(resolved, backlog);

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
