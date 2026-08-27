/**
 * The issue document: everything lookout knows about one defect, in one file.
 *
 * It is written the moment the issue is filed, not when somebody asks for it.
 * An issue folder that describes itself is the point of numbering issues at
 * all: `.lookout/issues/418203/ISSUE.md` answers "what is this" without the
 * tool, the backlog, or this conversation.
 *
 * lookout still does not dispatch work. This names no agent, sets no protocol,
 * and asks for nothing back. It is a document about a defect, sitting where
 * anyone who opens the folder will find it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { issueDir } from "./paths.js";
import type { FixCluster } from "../fix/cluster.js";
import { allRuleFiles } from "../fix/rules.js";
import { clusterLabel } from "../fix/brief.js";
import { have } from "../util.js";
import type { IssueRecord } from "../backlog/lib.js";
import type { ResolvedConfig } from "../types.js";

/**
 * How to invoke lookout from somewhere else on this machine.
 *
 * A handoff is read by an agent in another process, and telling it to run
 * `lookout` is only useful if that is actually on PATH. It often is not: this
 * repository is run straight out of its build. Falling back to the absolute
 * path of the running CLI means the command in the document is one that works.
 */
async function invocation(): Promise<string> {
  if (await have("lookout")) return "lookout";
  // Relative to this module, which is dist/issues/ in a real install. Checked
  // rather than assumed: running straight from the TypeScript resolves to a
  // file that does not exist, and a command that cannot run is worse than the
  // bare name somebody can at least look up.
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  return existsSync(cli) ? `${process.execPath} ${cli}` : "lookout";
}

/**
 * Everything known about one issue, in one file: what is wrong, where, what it
 * looks like, and what lookout has already ruled. Paths are absolute
 * throughout, because whoever opens this has to open them.
 */
export async function renderIssueDocument(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  record?: Pick<IssueRecord, "acceptance" | "causedBy">,
): Promise<{ markdown: string; label: string }> {
  const evDir = evidenceDir(resolved);
  const label = clusterLabel(cluster);
  const lookoutCmd = await invocation();
  const l: string[] = [];

  l.push(`# ${cluster.title}`, "");
  l.push("```");
  l.push(`issue:      ${cluster.id}`);
  l.push(`folder:     ${issueDir(resolved, cluster.id)}`);
  l.push(`severity:   ${cluster.severity}`);
  l.push(
    `defect:     ${cluster.category}${cluster.defects.length > 1 ? ` (${cluster.defects.length} rules)` : `/${cluster.attribute}`}`,
  );
  l.push(`found by:   ${cluster.channel === "ai" ? `visual judge${cluster.verified ? ", adversarially verified" : ""}` : "deterministic check"}`);
  l.push(`repository: ${resolved.projectDir}`);
  l.push(`routes:     ${cluster.routes.join(", ")}`);
  l.push(`affects:    ${cluster.shotCount} screenshot(s)`);
  if (cluster.attemptsSpent > 0) l.push(`attempts:   ${cluster.attemptsSpent} already spent`);
  l.push("```", "");

  l.push(
    "This is a visual defect lookout found in the running application, filed",
    "against the screenshots below. lookout did not send you here; somebody read",
    "it and decided to. Nothing about how you fix it is prescribed.",
    "",
  );

  // Rules before evidence. An agent that starts editing before it knows the
  // conventions has already done the damage by the time it reads them, and
  // lookout cannot rely on whichever tool this was opened in having loaded
  // anything: the global files are named explicitly for that reason.
  const rules = await allRuleFiles(resolved.projectDir);
  if (rules.length > 0) {
    l.push("## Read these first", "");
    l.push(
      "Standing rules that govern this work, operator-wide first, then this",
      "repository's. Read every one before editing anything.",
      "",
      ...rules.map((f) => `- ${f}`),
      "",
      "They are not advisory. Where one conflicts with anything below, the rule",
      "wins and you say so. Where it forbids the obvious fix, find the one it",
      "allows rather than the one it forbids.",
      "",
    );
  }

  l.push("## What is wrong", "");
  for (const d of cluster.defects) {
    l.push(`### ${d.title}`, "");
    l.push(`- **severity** ${d.severity}`, `- **rule** ${cluster.category}/${d.attribute}`, "");
    if (d.problem) l.push(d.problem, "");
  }
  if (cluster.expected) l.push("**Expected**", "", cluster.expected, "");
  if (cluster.observed) l.push("**Observed**", "", cluster.observed, "");

  // What this will be graded against, before the evidence and long before the
  // instruction at the end: whoever fixes this should know what has to be true
  // when they are done, not discover it from a failed verify-fix.
  const criteria = record?.acceptance ?? [];
  if (criteria.length > 0) {
    const mark = (v: string) => (v === "met" ? "x" : v === "not-verifiable" ? "-" : " ");
    l.push("## Acceptance criteria", "");
    l.push(
      "lookout rules on these itself, from fresh screenshots, when you ask it to",
      "verify a fix. Nothing else ticks them, including you.",
      "",
    );
    for (const c of criteria) {
      l.push(`- [${mark(c.verdict)}] ${c.text}`);
      if (c.verdict === "not-verifiable" && c.note) l.push(`      not verifiable: ${c.note}`);
    }
    l.push("");
  }

  l.push("## Look at these first", "");
  const seen = new Set<string>();
  for (const m of cluster.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || seen.has(ev.path)) continue;
    seen.add(ev.path);
    l.push(`- ${join(evDir, ev.path)}`);
    l.push(`  route ${m.route}, ${m.formFactor}, ${m.scheme} scheme, state ${m.state}`);
  }

  // The one thing lookout does ask for, because it is the only thing it can
  // answer: do not take your own word for it.
  l.push("## When you think it is fixed", "");
  l.push(
    "lookout is the only thing that can say the defect is actually gone. Ask it:",
    "",
    "```bash",
    `cd ${resolved.projectDir}`,
    `${lookoutCmd} verify-fix --issue ${cluster.id} --commit <sha> --note "<root cause>"`,
    "```",
    "",
    "It re-captures these routes, re-judges them, and either closes the finding",
    "or leaves it open with a note saying what it still sees. Exit 0 means",
    "confirmed, 1 means the defect is still there, 3 means it is out of attempts.",
    "",
  );

  return { markdown: l.join("\n"), label };
}

