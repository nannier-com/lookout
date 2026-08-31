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
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findIssue } from "../issues/registry.js";
import { issueDir, issueDocPath } from "../issues/paths.js";
import { materializeIssue } from "../issues/store.js";
import { loadBacklog } from "../verbs/backlog.js";
import { execFileAsync, have } from "../util.js";
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

/** One coding tool the page can hand an issue to. */
export interface ToolChoice {
  key: string;
  label: string;
  bin: string;
  installed: boolean;
  /** The tool's own mark, as inline SVG. Rendered as markup, not as text. */
  mark: string;
}

/** The tools, each with whether its binary is actually here. */
export async function toolsAvailable(resolved?: ResolvedConfig): Promise<ToolChoice[]> {
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

/**
 * Write the handoff and, where the platform allows it, open it in the chosen
 * tool in a new terminal. Reports honestly when it cannot: a button that
 * silently does nothing is worse than one that hands you the command.
 */
export async function launchHandoff(
  resolved: ResolvedConfig,
  issueId: string,
  toolKey: string,
): Promise<LaunchResult> {
  const tool = TOOLS[toolKey];
  if (!tool) {
    throw new LookoutError(
      `unknown tool ${toolKey}`,
      `one of: ${Object.keys(TOOLS).join(", ")}`,
    );
  }
  // The document is already on disk: every backlog save writes it. Regenerate
  // only when somebody has deleted the folder, which is allowed (it is a
  // projection) but leaves nothing to open.
  const backlog = await loadBacklog(resolved);
  const cluster = findIssue(backlog, issueId);
  const record = backlog.issues?.[issueId];
  if (!cluster || !record) {
    throw new LookoutError(`no issue with id ${issueId}`, "ids come from `lookout status`");
  }
  const dir = issueDir(resolved, issueId);
  const doc = issueDocPath(resolved, issueId);
  if (!existsSync(doc)) await materializeIssue(resolved, cluster, record);

  const prompt = `Read ${doc} and fix the issue it describes.`;
  const command = `${tool.bin} ${JSON.stringify(prompt)}`;
  const result: LaunchResult = {
    issue: issueId,
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
  const script = join(dir, "handoff.command");
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
