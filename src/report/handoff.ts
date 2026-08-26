/**
 * Handing one issue to whoever is going to fix it.
 *
 * lookout does not dispatch work and does not decide who does what. But when a
 * person reading the UI decides to act on an issue, everything that person's
 * tool needs is already on disk in scattered pieces: the finding prose in the
 * backlog, the pixels in the evidence directory, the ruling in a state file.
 * Collecting those into one document at the moment somebody asks is not
 * dispatch; it is saving them from assembling it by hand.
 *
 * The distinction that matters: this runs because a human clicked, it names no
 * subagent, it sets no protocol, and it asks for nothing back. It is a document
 * about a defect, handed over on request.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { clusterFindings } from "../fix/cluster.js";
import { allRuleFiles } from "../fix/rules.js";
import { clusterLabel } from "../fix/brief.js";
import { fixDir } from "../fix/state.js";
import { loadBacklog } from "../verbs/backlog.js";
import { execFileAsync } from "../util.js";
import { LookoutError, type ResolvedConfig } from "../types.js";

/**
 * Marks for the tool toggle.
 *
 * These are lookout's own drawings, not the vendors' official logos, which are
 * trademarks lookout has no copy of and would only reproduce badly from memory.
 * Both are recognisable in the shape and the colour their product uses, which
 * is all a two-button picker needs. Drop a real one at
 * `.lookout/logos/<key>.svg` and lookout uses that instead.
 */
const MARKS: Record<string, string> = {
  // A radial burst of tapered spokes, in Claude's orange.
  "claude-code":
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
    '<g fill="#D97757">' +
    Array.from({ length: 10 }, (_, i) => {
      const a = (i * 360) / 10;
      return (
        `<path transform="rotate(${a} 12 12)" ` +
        'd="M12 2.6 13.05 9.2 12 12 10.95 9.2Z"/>'
      );
    }).join("") +
    "</g></svg>",
  // Three elongated loops at 60 degrees, interleaving into a six-lobed knot.
  // A regular hexagon would not do: rotating one by 60 degrees maps it onto
  // itself, so all three land in exactly the same place and draw one hexagon.
  codex:
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.5">' +
    [0, 60, 120]
      .map((a) => `<ellipse cx="12" cy="12" rx="4.1" ry="9.2" transform="rotate(${a} 12 12)"/>`)
      .join("") +
    "</g></svg>",
};

/** The coding tools a handoff can be opened in. */
export const TOOLS: Record<string, { bin: string; label: string; mark: string }> = {
  "claude-code": { bin: "claude", label: "Claude Code", mark: MARKS["claude-code"]! },
  codex: { bin: "codex", label: "Codex", mark: MARKS.codex! },
};

/** A logo the project supplied, which beats anything lookout draws itself. */
function suppliedMark(resolved: ResolvedConfig, key: string): string | null {
  const p = join(resolved.projectDir, ".lookout", "logos", `${key}.svg`);
  try {
    if (!existsSync(p)) return null;
    const svg = readFileSync(p, "utf8");
    // Only an <svg> element, and only one: this goes straight into the page.
    if (!/^\s*<svg[\s>]/i.test(svg) || /<script/i.test(svg)) return null;
    return svg;
  } catch {
    return null;
  }
}

/** The tools, each with whether its binary is actually here. */
export async function toolsAvailable(
  resolved?: ResolvedConfig,
): Promise<{ key: string; label: string; bin: string; installed: boolean; mark: string }[]> {
  return Promise.all(
    Object.entries(TOOLS).map(async ([key, t]) => ({
      key,
      label: t.label,
      bin: t.bin,
      installed: await have(t.bin),
      mark: (resolved && suppliedMark(resolved, key)) || t.mark,
    })),
  );
}

export function handoffDir(resolved: ResolvedConfig): string {
  return join(fixDir(resolved), "handoff");
}

/**
 * Everything known about one issue, in one file: what is wrong, where, what it
 * looks like, and what lookout has already ruled. Paths are absolute
 * throughout, because whoever opens this has to open them.
 */
export async function renderHandoff(
  resolved: ResolvedConfig,
  clusterId: string,
): Promise<{ markdown: string; label: string }> {
  const backlog = await loadBacklog(resolved);
  const cluster = clusterFindings(Object.values(backlog.findings), {
    statuses: ["open", "blocked", "fixed", "by-design"],
  }).find((c) => c.id === clusterId);
  if (!cluster) {
    throw new LookoutError(`no issue with id ${clusterId}`, "ids come from `lookout status`");
  }

  const evDir = evidenceDir(resolved);
  const label = clusterLabel(cluster);
  const l: string[] = [];

  l.push(`# ${cluster.title}`, "");
  l.push("```");
  l.push(`issue:      ${cluster.id}`);
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
    `lookout verify-fix --cluster ${cluster.id} --commit <sha> --note "<root cause>"`,
    "```",
    "",
    "It re-captures these routes, re-judges them, and either closes the finding",
    "or leaves it open with a note saying what it still sees. Exit 0 means",
    "confirmed, 1 means the defect is still there, 3 means it is out of attempts.",
    "",
  );

  return { markdown: l.join("\n"), label };
}

export interface LaunchResult {
  issue: string;
  tool: string;
  toolLabel: string;
  /** The handoff document, absolute. */
  handoff: string;
  /** What to run, so a caller can copy it when launching is not possible. */
  command: string;
  launched: boolean;
  /** Why it was not launched, when it was not. */
  reason?: string;
}

/** Is the tool's binary actually on PATH? */
export async function have(bin: string): Promise<boolean> {
  try {
    await execFileAsync("command", ["-v", bin], { shell: true } as never);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the handoff and, where the platform allows it, open it in the chosen
 * tool in a new terminal. Reports honestly when it cannot: a button that
 * silently does nothing is worse than one that hands you the command.
 */
export async function launchHandoff(
  resolved: ResolvedConfig,
  clusterId: string,
  toolKey: string,
): Promise<LaunchResult> {
  const tool = TOOLS[toolKey];
  if (!tool) {
    throw new LookoutError(
      `unknown tool ${toolKey}`,
      `one of: ${Object.keys(TOOLS).join(", ")}`,
    );
  }
  const { markdown } = await renderHandoff(resolved, clusterId);
  const dir = handoffDir(resolved);
  await mkdir(dir, { recursive: true });
  const doc = join(dir, `${clusterId}.md`);
  await writeFile(doc, markdown);

  const prompt = `Read ${doc} and fix the issue it describes.`;
  const command = `${tool.bin} ${JSON.stringify(prompt)}`;
  const result: LaunchResult = {
    issue: clusterId,
    tool: toolKey,
    toolLabel: tool.label,
    handoff: doc,
    command,
    launched: false,
  };

  if (!(await have(tool.bin))) {
    result.reason = `${tool.bin} is not on PATH`;
    return result;
  }
  if (process.platform !== "darwin") {
    result.reason = `opening a terminal is only wired up for macOS; run it yourself`;
    return result;
  }

  // A .command file is the one thing macOS opens in a new Terminal window
  // without asking for automation permission first.
  const script = join(dir, `${clusterId}.command`);
  await writeFile(
    script,
    `#!/bin/sh\ncd ${JSON.stringify(resolved.projectDir)}\nexec ${command}\n`,
  );
  await chmod(script, 0o755);
  try {
    await execFileAsync("open", [script]);
    result.launched = true;
  } catch (e) {
    result.reason = (e as Error).message;
  }
  return result;
}
