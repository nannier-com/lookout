/**
 * The issue document: everything lookout knows about one defect, in one file.
 *
 * It is written the moment the issue is filed, not when somebody asks for it.
 * An issue folder that describes itself is the point of numbering issues at
 * all: `.lookout/issues/418203/Issue.md` answers "what is this" without the
 * tool, the backlog, or this conversation.
 *
 * lookout still does not dispatch work. This names no agent, sets no protocol,
 * and asks for nothing back. It is a document about a defect, sitting where
 * anyone who opens the folder will find it.
 *
 * This file is the assembly: the header, the standing rules, and the order the
 * sections come in. Each section lives in its own module beside this one.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { issueDir } from "./paths.js";
import { loadIssueContext, type IssueRecordView } from "./context.js";
import { acceptanceSection, placementSection, whatIsWrongSection } from "./doc-defects.js";
import { evidenceSection, rendersSection } from "./doc-evidence.js";
import { attemptsSection, scopeSection } from "./doc-attempts.js";
import { fixSection, verifySection } from "./doc-verify.js";
import { statusOf } from "./record.js";
import { commitUrl } from "../report/forge.js";
import type { FixCluster } from "../fix/cluster.js";
import { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";
import { allRuleFiles } from "../fix/rules.js";
import { clusterLabel } from "../fix/brief.js";
import { have } from "../util.js";
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
  record?: IssueRecordView,
): Promise<{ markdown: string; label: string }> {
  const ctx = await loadIssueContext(resolved, cluster, record);
  const label = clusterLabel(cluster);
  const lookoutCmd = await invocation();
  const l: string[] = [];

  l.push(`# ${cluster.title}`, "");
  l.push("```");
  l.push(`issue:      ${cluster.id}`);
  l.push(`folder:     ${issueDir(resolved, cluster.id)}`);
  l.push(`status:     ${statusOf(cluster.members)}`);
  // The adjudication or the blocked reason, when one was written: it is the
  // one line a person wrote about this issue, and the first thing to read.
  const reason = cluster.members.find((m) => m.reason)?.reason;
  if (reason) l.push(`reason:     ${reason}`);
  l.push(`severity:   ${cluster.severity}`);
  l.push(`confidence: ${cluster.members[0]?.confidence ?? "high"}`);
  const regions = [...new Set(cluster.members.map((m) => m.region).filter(Boolean))];
  if (regions.length > 0) l.push(`region:     ${regions.join(", ")}`);
  l.push(
    `defect:     ${cluster.category}${cluster.defects.length > 1 ? ` (${cluster.defects.length} rules)` : `/${cluster.attribute}`}`,
  );
  l.push(
    `found by:   ${
      cluster.channel === "ai"
        ? `${cluster.judge ?? "visual judge"}${cluster.verified ? ", adversarially verified" : ""}`
        : cluster.channel === "code"
          ? "source scan"
          : "deterministic check"
    }`,
  );
  l.push(`repository: ${resolved.projectDir}`);
  if (cluster.channel === "code") {
    l.push(`file:       ${cluster.routes.join(", ")}`);
  } else {
    l.push(`routes:     ${cluster.routes.join(", ")}`);
    // Every route the defect has been photographed on, when that is more than
    // the ones it is filed under: a shell defect is verified on all of them.
    const seenOn = [...new Set(cluster.members.flatMap((m) => m.seenRoutes ?? []))].sort();
    if (seenOn.some((r) => !cluster.routes.includes(r))) {
      l.push(`seen on:    ${[...new Set([...cluster.routes, ...seenOn])].sort().join(", ")}`);
    }
    l.push(`affects:    ${cluster.shotCount} screenshot(s)`);
  }
  if (cluster.attemptsSpent > 0) {
    l.push(`attempts:   ${cluster.attemptsSpent} of ${DEFAULT_MAX_ATTEMPTS} spent (${DEFAULT_MAX_ATTEMPTS} is the default cap; verify-fix --max-attempts raises it)`);
  }
  // A regression is filed with where it came from, and the fixer of a
  // regression starts from that commit, not from the screenshot.
  if (record?.causedBy) {
    const c = record.causedBy;
    const forge = await ctx.forge();
    const url = c.commit && forge ? commitUrl(forge, c.commit) : null;
    l.push(
      `caused by:  fixing issue ${c.issue}${c.commit ? ` at ${c.commit}` : ""}${url ? ` (${url})` : ""}, run ${c.runId}, ${c.at}`,
    );
  }
  l.push("```", "");

  l.push(
    ...(cluster.channel === "code"
      ? [
          "This is a defect lookout found by reading the source, not by looking at the",
          "running application: nothing about it is visible in a screenshot, which is",
          "why it has none. lookout rules on it the same way it found it, by reading",
          "the source again. lookout did not send you here; somebody read it and",
          "decided to. Nothing about how you fix it is prescribed.",
          "",
        ]
      : [
          "This is a visual defect lookout found in the running application, filed",
          "against the screenshots below. lookout did not send you here; somebody read",
          "it and decided to. Nothing about how you fix it is prescribed.",
          "",
        ]),
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

  l.push(...placementSection(ctx));
  l.push(...whatIsWrongSection(ctx));
  l.push(...acceptanceSection(ctx));
  // Between the criteria and the pictures on purpose: somebody who reads the
  // pictures first starts planning the fix they already imagine, and the
  // history is what says which of those plans has already failed.
  l.push(...attemptsSection(ctx, lookoutCmd));
  l.push(...evidenceSection(ctx));
  if (cluster.channel !== "code") l.push(...rendersSection(ctx));
  l.push(...scopeSection(ctx));
  l.push(...(await fixSection(ctx)));
  l.push(...verifySection(ctx, lookoutCmd));

  return { markdown: l.join("\n"), label };
}
