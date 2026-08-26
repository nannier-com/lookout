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
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { clusterFindings } from "../fix/cluster.js";
import { clusterLabel } from "../fix/brief.js";
import { fixDir } from "../fix/state.js";
import { loadBacklog } from "../verbs/backlog.js";
import { execFileAsync } from "../util.js";
import { LookoutError, type ResolvedConfig } from "../types.js";

/** The coding tools a handoff can be opened in. */
export const TOOLS: Record<string, { bin: string; label: string }> = {
  "claude-code": { bin: "claude", label: "Claude Code" },
  codex: { bin: "codex", label: "Codex" },
};

/** The tools, each with whether its binary is actually here. */
export async function toolsAvailable(): Promise<
  { key: string; label: string; bin: string; installed: boolean }[]
> {
  return Promise.all(
    Object.entries(TOOLS).map(async ([key, t]) => ({
      key,
      label: t.label,
      bin: t.bin,
      installed: await have(t.bin),
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
  const sheet = join(fixDir(resolved), `${cluster.id}.sheet.png`);
  l.push("", `All of them in one image: ${sheet}`, "");

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
