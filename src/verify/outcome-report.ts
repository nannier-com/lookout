/**
 * How a visual verify-fix outcome reaches the caller: the JSON payload
 * verbatim, or the human account with the acceptance card and the issues the
 * run spawned. Split from the verb when it crossed the line ceiling; the
 * verb decides, this file says.
 */
import { acceptanceTally, type AcceptanceCriterion } from "../issues/acceptance.js";
import { sheetNote } from "../capture/sheet.js";
import { printJson } from "../util.js";
import type { SheetResult } from "../capture/sheet.js";
import type { Verdict } from "../fix/rule.js";

export function printFixOutcome(args: {
  json: boolean;
  payload: Record<string, unknown>;
  issueId: string;
  verdict: Verdict;
  attempt: number;
  maxAttempts: number;
  judgeNote: string;
  ruledCriteria: AcceptanceCriterion[];
  spawned: { issue: { id: string; title: string; severity: string }; causedByThisFix: boolean }[];
  sheet: SheetResult | null;
}): void {
  const { json, payload, issueId, verdict, attempt, maxAttempts, judgeNote, ruledCriteria, spawned, sheet } = args;
  if (json) {
    printJson(payload);
    return;
  }
  console.log(
    `\n${issueId}: ${verdict} (attempt ${attempt} of ${maxAttempts})` +
      (judgeNote ? `\n  judge: ${judgeNote}` : "") +
      `\n  ${payload.next as string}`,
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
