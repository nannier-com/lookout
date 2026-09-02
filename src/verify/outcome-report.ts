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
import { FORM_FACTORS, SCHEMES } from "../types.js";
import type { SheetResult } from "../capture/sheet.js";
import type { ShotMove } from "./moved.js";
import type { RepoObservation } from "../fix/state.js";
import type { BaselineDescription } from "./baseline.js";
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
  /** How far each changed screenshot moved, largest first, capped at MAX_MOVES. */
  moved: ShotMove[];
  /**
   * How many changed screenshots were measured at all, before the cap. Carried
   * separately because `moved.length` is the truncated list: subtracting it
   * from `changedShots` counted every move the cap dropped as one nothing could
   * measure, which is a different and untrue statement.
   */
  measuredShots: number;
  /** Routes whose pixels did not move since filing. */
  unclosable: string[];
  reportedCommit: string | null;
  reportedNote: string | null;
  observed?: RepoObservation;
  /** The issue's document, which the save just rewrote with this attempt. */
  docPath: string;
  /** The capture this ruling's screenshots were compared against. */
  baseline: BaselineDescription;
  /** What this ruling photographed. */
  photographed: { url: string | null; routes: string[] };
  flags: Record<string, string | boolean>;
  costUsd: number;
  learned?: unknown;
}

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
  const formFactors: string[] = list(a.flags.viewports) ?? [...FORM_FACTORS];
  const schemes: string[] = list(a.flags.schemes) ?? [...SCHEMES];
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
    moved: a.moved,
    measuredShots: a.measuredShots,
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

/** What a ruling compared against, said so a reader knows whether a check since the edit could have moved it. */
export function baselineSaid(b: BaselineDescription): string {
  if (b.kind === "ruling") return `the previous ruling's capture (run ${b.runId}, ${b.at})`;
  if (b.kind === "frozen") return `the frames frozen when this was filed (${b.at})`;
  return "the workspace's last capture of these routes";
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
    `  compared against: ${baselineSaid(a.baseline)}; ` +
      `${a.changedShots} of ${a.baselineShots} comparable screenshot(s) changed (${a.totalShots} in scope)`,
  );
  // How much moved, largest first. A shot counted as changed and missing here
  // moved by an amount nothing could measure, and the last line says so rather
  // than letting its absence read as "barely moved".
  for (const m of a.moved) out.push(`  moved: ${m.shotId}: ${m.said}`);
  // Two different remainders, and conflating them told the reader that a
  // measured move was unmeasurable.
  const capped = a.measuredShots - a.moved.length;
  const unmeasured = a.changedShots - a.measuredShots;
  if (capped > 0) out.push(`  moved: ${capped} more measured, not listed`);
  if (unmeasured > 0) {
    out.push(`  moved: ${unmeasured} more changed, by how much was not measured (no baseline pixels on hand)`);
  }
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
