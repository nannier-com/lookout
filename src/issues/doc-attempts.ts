/**
 * What has been tried: every attempt lookout has ruled on, as it was reported
 * and as it was ruled, so the next attempt starts from what the last one
 * learned rather than from the screenshot alone.
 *
 * The sentences are the board's own (`src/fix/attempts.ts`); this section only
 * arranges them under the attempt they belong to and adds what the card has no
 * room for: that a judge's account repeated word for word, and what a blocked
 * issue's next ruling will count as.
 */
import { attemptSentences } from "../fix/attempts.js";
import { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";
import type { IssueContext } from "./context.js";

export function attemptsSection(ctx: IssueContext, lookoutCmd: string): string[] {
  const { cluster, state } = ctx;
  if (state.attempts.length === 0) return [];
  const l: string[] = [];
  const n = state.attempts.length;
  l.push("## What has been tried", "");
  l.push(
    `lookout has ruled on ${n} attempt${n === 1 ? "" : "s"} to fix this. Each one is recorded`,
    "as it was reported and as lookout ruled on it, so the next attempt can start",
    "from what the last one learned rather than from the screenshots alone.",
    "",
  );
  let previousNote: string | undefined;
  for (const a of state.attempts) {
    const said = attemptSentences(a);
    l.push(`### attempt ${a.n}, ${a.dispatchedAt}`, "");
    if (said.claimed) l.push(`- ${said.claimed}`);
    if (said.surfaced) l.push(`- ${said.surfaced}`);
    if (said.verdict) {
      // A judge that saw the same thing twice is the finding, and worth more
      // than the sentence again: the fix did not reach what the judge looks at.
      const same = a.judgeNote !== undefined && a.judgeNote === previousNote;
      l.push(same ? `- lookout ruled it ${a.verdict}: unchanged from attempt ${a.n - 1}` : `- ${said.verdict}`);
    }
    if (a.judgeNote !== undefined) previousNote = a.judgeNote;
    l.push("");
  }

  if (cluster.members.some((m) => m.status === "blocked")) {
    const spent = cluster.attemptsSpent;
    l.push(
      `This issue is blocked: ${spent} attempt${spent === 1 ? "" : "s"} did not clear it, and`,
      "`verify-fix` answers exit 3 for it without looking. Reopening it:",
      "",
      "```bash",
      `${lookoutCmd} backlog set --issue ${cluster.id} --status open`,
      "```",
      "",
      `The next ruling then counts as attempt ${spent + 1}. With the default cap of`,
      `${DEFAULT_MAX_ATTEMPTS} it blocks again unless it passes; \`--max-attempts ${spent + 2}\` on that`,
      "ruling leaves one more round after it.",
      "",
    );
  }
  return l;
}
