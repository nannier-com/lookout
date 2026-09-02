/**
 * The middle of the issue document: where the fix belongs, what is wrong, and
 * what has to be true when it is fixed.
 */
import { existsSync } from "node:fs";
import type { IssueContext } from "./context.js";

/**
 * Where before what. Somebody who reads the defect first has already started
 * forming a plan to fix it on the screen they saw it on, and in a project
 * with a design system that plan is usually wrong. This is also why it sits
 * under the standing rules rather than above them: the rules say how to work
 * here, this says where.
 */
export function placementSection(ctx: IssueContext): string[] {
  const p = ctx.record?.placement;
  if (!p) return [];
  const l: string[] = [];
  // Each phrase completes "The fix belongs ...", except the one that cannot.
  const WHERE: Record<string, string> = {
    "kit-component": `The fix belongs in ${p.kit} itself, in the component, where it is made once for every caller.`,
    "app-composition": `The fix belongs in this application's use of ${p.kit}, not in the kit.`,
    tokens: "The fix belongs in the design tokens, which moves everything using them.",
    "kit-gap": `The fix belongs in ${p.kit}: add or extend what is missing there, backwards-compatibly, then consume it.`,
    unclear: "Reading the source did not settle where the fix belongs. See the note below, and decide it yourself.",
  };
  l.push("## Where this belongs", "");
  l.push(`This project uses **${p.kit}**. ${WHERE[p.kind] ?? p.kind}`, "");
  if (p.primaryPath) {
    // The path existed when the placement was written; the annotation is
    // for the record a fixer opens after the file moved, before the next
    // check's staleness sweep re-derives it.
    const gone = !existsSync(p.primaryPath)
      ? "  (this file no longer exists; lookout re-derives the placement on the next check)"
      : "";
    l.push(`- **change** ${p.primaryPath}${p.symbol ? `  (${p.symbol})` : ""}${gone}`);
  }
  if (p.reason) l.push(`- **why there** ${p.reason}`);
  if (p.otherCallers !== null && p.otherCallers > 0) {
    l.push(
      `- **other callers** ${p.otherCallers} other place(s) use this. A change here reaches all of them.`,
    );
  }
  if (p.blastRadius) l.push(`- **blast radius** ${p.blastRadius}`);
  for (const f of p.alsoRead) l.push(`- **read first** ${f}`);
  if (p.notes) l.push(`- **unsettled** ${p.notes}`);
  l.push("");

  if (!p.kitEditable) {
    l.push(
      `${p.kit} is an installed dependency, so its source is not this repository's to`,
      "edit. Do not patch it in node_modules: that is undone by the next install and",
      "invisible to everyone else. Fix this application's use of it, and if the real",
      "fix belongs in the kit, say so rather than working around it here.",
      "",
    );
  }
  l.push(
    "lookout worked this out by reading the repository, not by looking at the",
    "screenshots. It is where to start, not an instruction: if the code says",
    "otherwise when you open it, the code is right.",
    "",
  );
  return l;
}

export function whatIsWrongSection(ctx: IssueContext): string[] {
  const { cluster } = ctx;
  const l: string[] = [];
  l.push("## What is wrong", "");
  for (const d of cluster.defects) {
    l.push(`### ${d.title}`, "");
    l.push(`- **severity** ${d.severity}`, `- **rule** ${cluster.category}/${d.attribute}`, "");
    // A finding filed before lookout explained its own checks carries a problem
    // that is its title again, and printing it made this section the same
    // sentence three times over. The next capture replaces it with the real
    // explanation; until then, saying it once is the honest rendering.
    if (d.problem && d.problem.trim() !== d.title.trim()) l.push(d.problem, "");
  }
  if (cluster.expected) l.push("**Expected**", "", cluster.expected, "");
  if (cluster.observed) l.push("**Observed**", "", cluster.observed, "");
  return l;
}

/**
 * What this will be graded against, before the evidence and long before the
 * instruction at the end: whoever fixes this should know what has to be true
 * when they are done, not discover it from a failed verify-fix.
 */
export function acceptanceSection(ctx: IssueContext): string[] {
  const criteria = ctx.record?.acceptance ?? [];
  if (criteria.length === 0) return [];
  const l: string[] = [];
  // Four marks for four verdicts. A criterion checked and failed used to draw
  // the same empty box as one never checked, which hid the one fact a second
  // attempt most needs: what the last ruling saw.
  const MARK: Record<string, string> = { met: "x", unmet: "!", "not-verifiable": "-", pending: " " };
  const SAID: Record<string, string> = { met: "met", unmet: "not met", "not-verifiable": "could not be verified" };
  l.push("## Acceptance criteria", "");
  l.push(
    "lookout rules on these itself, from fresh screenshots, when you ask it to",
    "verify a fix. Nothing else ticks them, including you. `[x]` was met at the",
    "last ruling, `[!]` was not, `[-]` could not be decided from the screenshots,",
    "and `[ ]` has not been ruled on yet.",
    "",
  );
  for (const c of criteria) {
    l.push(`- [${MARK[c.verdict] ?? " "}] ${c.text}`);
    // Nested under the item rather than indented after it: an indented line
    // with no blank line before it is a continuation of the item in markdown,
    // and the note ran into the criterion as one sentence.
    if (c.verdict !== "pending" && c.note) l.push(`  - ${SAID[c.verdict] ?? c.verdict}: ${c.note}`);
    if (c.ruledAt) l.push(`  - ruled ${c.ruledAt}${c.runId ? ` by run ${c.runId}` : ""}`);
  }
  l.push("");
  return l;
}
