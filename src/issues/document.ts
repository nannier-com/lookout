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
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { evidenceDir } from "../config.js";
import { issueDir } from "./paths.js";
import { frameAbsPath, loadFrames } from "./frames.js";
import { commitUrl, forgeOf } from "../report/forge.js";
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
  record?: Pick<IssueRecord, "acceptance" | "causedBy" | "placement">,
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
    l.push(`affects:    ${cluster.shotCount} screenshot(s)`);
  }
  if (cluster.attemptsSpent > 0) l.push(`attempts:   ${cluster.attemptsSpent} already spent`);
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

  // Where before what. Somebody who reads the defect first has already started
  // forming a plan to fix it on the screen they saw it on, and in a project
  // with a design system that plan is usually wrong. This is also why it sits
  // under the standing rules rather than above them: the rules say how to work
  // here, this says where.
  if (record?.placement) {
    const p = record.placement;
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

  if (cluster.channel === "code") {
    l.push("## Where it is", "");
    const places = new Set<string>();
    for (const m of cluster.members) {
      if (!m.source) continue;
      const at = `- ${m.source.path}:${m.source.line}${m.source.symbol ? `  (${m.source.symbol})` : ""}`;
      if (places.has(at)) continue;
      places.add(at);
      l.push(at);
    }
    l.push("");
  } else {
    l.push("## Look at these first", "");
    // The frozen frames rather than the live workspace, whenever there are
    // any. The workspace keeps one file per view and overwrites it on every
    // capture, so by the time somebody opens this document its copy of the
    // defect may already be a picture of whatever replaced it. The frames live
    // in this issue's own folder and do not move.
    const frames = await loadFrames(resolved, cluster.id);
    const where = (f: { route: string; formFactor: string; scheme: string; state?: string }): string =>
      "  " + [`route ${f.route}`, f.formFactor, `${f.scheme} scheme`, f.state ? `state ${f.state}` : ""]
        .filter(Boolean).join(", ");
    if (frames.before.length > 0) {
      for (const f of frames.before) l.push(`- ${frameAbsPath(resolved, cluster.id, f)}`, where(f));
      if (frames.after.length > 0) {
        l.push("", "The same views after the fix lookout ruled on:", "");
        for (const f of frames.after) l.push(`- ${frameAbsPath(resolved, cluster.id, f)}`, where(f));
      }
    } else {
      const seen = new Set<string>();
      for (const m of cluster.members) {
        const ev = m.evidence[m.evidence.length - 1];
        if (!ev || seen.has(ev.path)) continue;
        seen.add(ev.path);
        l.push(`- ${join(evDir, ev.path)}`);
        l.push(`  route ${m.route}, ${m.formFactor}, ${m.scheme} scheme, state ${m.state}`);
      }
    }

    // Where it was rendering, when capture joined the finding to an element.
    // Facts observed on the page, not placement advice; a path is printed only
    // after it is verified to exist, and a member whose file is gone still
    // names its component.
    const rendered = new Map<string, string>();
    for (const m of cluster.members) {
      const r = m.renderedBy;
      if (!r || (!r.component && !r.file && !r.cssPath)) continue;
      let at = "";
      if (r.file) {
        const abs = isAbsolute(r.file) ? r.file : join(resolved.projectDir, r.file);
        if (existsSync(abs)) at = `  (${abs}${r.line ? `:${r.line}` : ""})`;
      }
      const line = `- ${r.component ?? r.cssPath}${at}`;
      rendered.set(line, line);
    }
    if (rendered.size > 0) {
      l.push("", "## Where it renders", "");
      l.push(
        "Recorded from the running page at capture time: the element each check",
        "fired on, and its source where the page's dev tooling said. A starting",
        "point for finding the code; the section above (when present) says where",
        "the fix belongs.",
        "",
        ...rendered.values(),
      );
    }
  }

  // The one thing lookout does ask for, because it is the only thing it can
  // answer: do not take your own word for it.
  // The commit that closed it, once one has. A document for an issue nobody has
  // fixed yet has nothing to say here and says nothing; a document for a fixed
  // one is a record, and the diff is the most useful thing in it.
  const fixedIn = cluster.members.find((m) => m.fixedIn?.commit)?.fixedIn?.commit;
  if (fixedIn) {
    const forge = await forgeOf(resolved.projectDir);
    const url = forge ? commitUrl(forge, fixedIn) : null;
    l.push("## The fix", "");
    l.push(
      `lookout confirmed this defect gone in \`${fixedIn}\`.`,
      ...(url ? ["", url] : ["", "The repository has no remote to read that commit on."]),
      "",
    );
  }

  l.push("## When you think it is fixed", "");
  l.push(
    "lookout is the only thing that can say the defect is actually gone. Ask it:",
    "",
    "```bash",
    `cd ${resolved.projectDir}`,
    `${lookoutCmd} verify-fix --issue ${cluster.id} --commit <sha> --note "<root cause>"`,
    "```",
    "",
    ...(cluster.channel === "code"
      ? [
          "It re-reads the source and either closes the finding or leaves it open with",
          "a note saying what the scan still sees. Nothing is re-photographed: this",
          "defect was never visible in a screenshot.",
        ]
      : [
          "It re-captures these routes, re-judges them, and either closes the finding",
          "or leaves it open with a note saying what it still sees.",
        ]),
    "Exit 0 means confirmed, 1 means the defect is still there, 3 means it is out",
    "of attempts.",
    "",
  );

  return { markdown: l.join("\n"), label };
}

