/**
 * How a visual verify-fix outcome reaches the caller: the JSON payload
 * verbatim, or the human account with everything the regenerated document
 * carries about this attempt. The verb decides, this file says.
 *
 * A session that stays alive reads stdout; one opened fresh reads the
 * document. Both have to learn the same facts about the ruling, so the
 * payload and the printed account are built from one set of arguments here.
 */
import { acceptanceTally, type AcceptanceCriterion } from "../issues/acceptance.js";
import { sheetNote } from "../capture/sheet.js";
import { list, printJson } from "../util.js";
import type { SheetResult } from "../capture/sheet.js";
import type { RepoObservation } from "../fix/state.js";
import type { Verdict } from "../fix/rule.js";

export interface FixOutcomeArgs {
  issueId: string;
  verdict: Verdict;
  attempt: number;
  maxAttempts: number;
  judgeNote: string;
  ruledCriteria: AcceptanceCriterion[];
  spawned: { issue: { id: string; title: string; severity: string }; causedByThisFix: boolean }[];
  sheet: SheetResult | null;
  /** Every finding still filed after this ruling, with the judge's account. */
  stillOpen: { title: string; shotId: string; observed: string }[];
  changedShots: number;
  baselineShots: number;
  totalShots: number;
  /** Routes whose pixels did not move since filing. */
  unclosable: string[];
  reportedCommit: string | null;
  reportedNote: string | null;
  observed?: RepoObservation;
  /** The issue's document, which the save just rewrote with this attempt. */
  docPath: string;
  /** The capture this ruling's screenshots were compared against. */
  baseline: { runId: string; finishedAt: string } | null;
  /** What this ruling photographed. */
  photographed: { url: string | null; routes: string[] };
  flags: Record<string, string | boolean>;
  costUsd: number;
  learned?: unknown;
}

const FORM_FACTORS = ["desktop", "tablet", "phone"];
const SCHEMES = ["dark", "light"];

function nextOf(a: FixOutcomeArgs): string {
  const head =
    a.verdict === "passed"
      ? "confirmed and adjudicated; the finding is closed"
      : a.verdict === "blocked"
        ? `attempts exhausted; this one needs a person. \`lookout backlog set --issue ${a.issueId} --status open\` reopens it`
        : "the defect is still there; the finding stays open";
  const spawned =
    a.spawned.length > 0
      ? `. ${a.spawned.length} new issue(s) were filed in this run (${a.spawned.map((s) => s.issue.id).join(", ")}); they are separate work`
      : "";
  return head + spawned;
}

/** The `--json` payload: the same facts the printed account and the document carry. */
export function fixPayload(a: FixOutcomeArgs): Record<string, unknown> {
  const formFactors = list(a.flags.viewports) ?? FORM_FACTORS;
  const schemes = list(a.flags.schemes) ?? SCHEMES;
  return {
    issue: a.issueId,
    verdict: a.verdict,
    attempt: a.attempt,
    maxAttempts: a.maxAttempts,
    attemptsLeft: a.verdict === "passed" ? null : Math.max(0, a.maxAttempts - a.attempt),
    stillOpen: a.stillOpen,
    changedShots: a.changedShots,
    baselineShots: a.baselineShots,
    totalShots: a.totalShots,
    unclosable: a.unclosable,
    baseline: a.baseline,
    photographed: { ...a.photographed, formFactors, schemes },
    // New issues this run filed. Separate work, with their own numbers; this
    // issue's verdict does not turn on them.
    spawned: a.spawned.map((s) => ({
      issue: s.issue.id,
      title: s.issue.title,
      severity: s.issue.severity,
      causedByThisFix: s.causedByThisFix,
    })),
    judgeNote: a.judgeNote || null,
    acceptance: a.ruledCriteria.map((c) => ({
      id: c.id,
      text: c.text,
      source: c.source,
      verdict: c.verdict,
      note: c.note ?? null,
      evidence: c.evidence ?? [],
      suggestion: c.suggestion ?? null,
    })),
    commit: a.reportedCommit,
    reported: { commit: a.reportedCommit, note: a.reportedNote },
    observed: a.observed ?? null,
    doc: a.docPath,
    next: nextOf(a),
    costUsd: a.costUsd,
    contactSheet: a.sheet?.path ?? null,
    ...(a.learned !== undefined ? { learned: a.learned } : {}),
  };
}

const MARK: Record<string, string> = { met: "x", unmet: "!", "not-verifiable": "-", pending: " " };
const SAID: Record<string, string> = { unmet: "not met", "not-verifiable": "could not be verified", met: "met" };

/** What lookout observed in the repository, as one line. */
function repoLine(a: FixOutcomeArgs): string {
  const parts: string[] = [];
  if (a.reportedCommit) parts.push(`commit ${a.reportedCommit}`);
  const o = a.observed;
  if (o?.head && o.head !== a.reportedCommit) parts.push(`HEAD ${o.head}`);
  if (o?.dirty === true) parts.push(`${o.dirtyFiles?.length ?? 0} uncommitted file(s)${o.dirtyFiles?.length ? `: ${o.dirtyFiles.join(", ")}` : ""}`);
  else if (o?.dirty === false) parts.push("working tree clean");
  if (o?.filesChanged) {
    parts.push(o.filesChanged.length === 0 ? "no files changed since the previous attempt" : `changed since the previous attempt: ${o.filesChanged.join(", ")}`);
  }
  return parts.join("; ");
}

export function printFixOutcome(args: FixOutcomeArgs & { json: boolean; payload: Record<string, unknown> }): void {
  const a = args;
  if (a.json) {
    printJson(a.payload);
    return;
  }
  const left = a.maxAttempts - a.attempt;
  const standing =
    a.verdict === "passed"
      ? ""
      : a.verdict === "blocked"
        ? "; out of attempts"
        : `; ${left} more before it blocks`;
  const out: string[] = [`\n${a.issueId}: ${a.verdict} (attempt ${a.attempt} of ${a.maxAttempts}${standing})`];
  if (a.judgeNote) out.push(`  judge: ${a.judgeNote}`);
  const p = a.payload.photographed as { formFactors: string[]; schemes: string[] };
  out.push(
    `  photographed: ${a.photographed.url ?? "the target"} at ${a.photographed.routes.join(", ")}; ` +
      `${p.formFactors.join(", ")}; ${p.schemes.join(", ")}`,
  );
  out.push(
    `  compared against: ${a.baseline ? `run ${a.baseline.runId}, finished ${a.baseline.finishedAt}` : "no previous capture"}; ` +
      `${a.changedShots} of ${a.baselineShots} comparable screenshot(s) changed (${a.totalShots} in scope)`,
  );
  if (a.unclosable.length > 0) out.push(`  pixels unchanged since filing on ${a.unclosable.join(", ")}: nothing there could close`);
  if (a.stillOpen.length > 0) {
    out.push("  still open:");
    for (const f of a.stillOpen) {
      out.push(`    - ${f.title}${f.shotId ? ` (${f.shotId})` : ""}`);
      if (f.observed) out.push(`      judge: ${f.observed}`);
    }
  }
  const tally = acceptanceTally(a.ruledCriteria);
  if (tally.total > 0) {
    out.push(
      `  acceptance: ${tally.met}/${tally.total} met` +
        (tally.unmet ? `, ${tally.unmet} failing` : "") +
        (tally.notVerifiable ? `, ${tally.notVerifiable} not verifiable` : "") +
        (tally.pending ? `, ${tally.pending} not checked` : ""),
    );
    for (const c of a.ruledCriteria) {
      out.push(`    [${MARK[c.verdict] ?? " "}] ${c.text}`);
      if (c.verdict !== "pending" && c.note && c.verdict !== "met") out.push(`        ${SAID[c.verdict] ?? c.verdict}: ${c.note}`);
      if (c.evidence && c.evidence.length > 0) out.push(`        decided on: ${c.evidence.join(", ")}`);
      if (c.suggestion) out.push(`        suggestion: ${c.suggestion}`);
    }
  }
  const repo = repoLine(a);
  if (repo) out.push(`  recorded: ${repo}`);
  if (a.reportedNote) out.push(`    note: ${JSON.stringify(a.reportedNote)}`);
  for (const s of a.spawned) {
    out.push(`  new issue ${s.issue.id}: ${s.issue.title} (${s.issue.severity})` + (s.causedByThisFix ? ", on pixels this fix moved" : ""));
  }
  out.push(`  next: ${a.payload.next as string}`);
  out.push(`        ${a.docPath} now carries this attempt.`);
  console.log(out.join("\n"));
  if (a.sheet) console.log(`\n${sheetNote(a.sheet)}`);
}
