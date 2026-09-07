/**
 * Handing one issue to whoever is going to fix it.
 *
 * lookout does not decide what needs doing or who does it. But when a
 * person reading the UI decides to act on an issue, everything that person's
 * tool needs is already on disk in scattered pieces: the finding prose in the
 * backlog, the pixels in the evidence directory, the ruling in a state file.
 * Collecting those into one document at the moment somebody asks is not
 * dispatch; it is saving them from assembling it by hand.
 *
 * The distinction that matters: this runs because a human queued this issue, it
 * names no subagent, and it sets no protocol. It asks one thing back, and only
 * one: that lookout be allowed to rule on the result. That is the question
 * lookout exists to answer, and the queue cannot move without it.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { invocation } from "../issues/document.js";
import { findIssue } from "../issues/registry.js";
import { issueDir, issueDocPath } from "../issues/paths.js";
import { materializeIssue } from "../issues/store.js";
import { loadBacklog } from "../verbs/backlog.js";
import { leaseScript } from "../ui/lease.js";
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

/**
 * Where two agents working one issue leave each other notes.
 *
 * In the issue's own folder, beside the document and the pixels, because it is
 * about this issue and it is as disposable as they are. A tree is a poor place
 * to consult through: the reviewer can see WHAT changed and not why, and "why"
 * is the whole of what a second opinion is for.
 */
export const CONSULT_FILE = "consult.md";

/**
 * What to say to an agent that is not working alone, or nothing when it is.
 *
 * Deliberately two sentences rather than a protocol document. lookout is not
 * running a meeting: it hands over an issue, and when it hands the same issue
 * to a second tool it says so and points at the note. Everything else about how
 * to fix code belongs to the tool and to the repository's own rules, which the
 * issue document already lists.
 */
export function consultBrief(tools: string[], turn: number, notes: string): string {
  if (tools.length < 2) return "";
  const mine = tools[turn % tools.length]!;
  const others = tools.filter((t) => t !== mine).map((t) => TOOLS[t]?.label ?? t);
  // Only the very first turn is the drafting one. A tool that comes round again
  // after a full rotation is reviewing what happened since, not starting.
  if (turn === 0) {
    return ` ${others.join(" and ")} will review your work after you,`
      + ` so write what you changed and why to ${notes} before you finish.`;
  }
  return ` ${others.join(" and ")} worked this issue before you: read ${notes} and the`
    + ` working tree, say in that file where their reasoning is wrong or incomplete,`
    + ` and fix what is left.`;
}

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
 * Write the handoff and, where the platform allows it, open it in the tool
 * whose turn it is, in a new terminal. Reports honestly when it cannot: a
 * button that silently does nothing is worse than one that hands you the
 * command.
 *
 * `tools` is a list because the page's picker is a selector. One name is the
 * whole story and behaves exactly as it always did. Two mean they consult, and
 * consulting is turns rather than a committee: `turn` indexes the list, so the
 * second agent opens on a tree the first has already worked and a note saying
 * what it did. Nothing here decides when a turn is over; the queue does, on the
 * only evidence there is that one was spent.
 */
export async function launchHandoff(
  resolved: ResolvedConfig,
  issueId: string,
  tools: string[],
  turn = 0,
): Promise<LaunchResult> {
  if (!tools.length) throw new LookoutError("no tool to hand this to", "the page sends the selected tools");
  const toolKey = tools[turn % tools.length]!;
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
  if (!existsSync(doc)) await materializeIssue(resolved, cluster, record, { backlog });

  // Two sentences, because the second one is what the queue waits on. The
  // command is in the document too, near the end of it, and an agent that
  // fixed the defect and stopped there left the queue parked on this issue
  // with nothing to say why. Asking in the first turn is the difference
  // between a loop that advances and one that silently does not.
  const verify = `${await invocation()} verify-fix --issue ${issueId}`;
  const prompt =
    `Read ${doc} and fix the issue it describes.`
    + consultBrief(tools, turn, join(dir, CONSULT_FILE))
    + ` When you believe it is fixed, run \`${verify}\` so lookout can rule on it.`;
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
  //
  // It takes the queue's lease before it starts the tool and drops it however
  // the window ends, because this is the only place that can: `open` returns as
  // soon as Terminal has the file, so the server never holds a handle on the
  // session it just started and cannot see for itself when the agent is done.
  // See src/ui/lease.ts for why "lookout has ruled" was the wrong question.
  const script = join(dir, "handoff.command");
  await writeFile(script, leaseScript(resolved.projectDir, issueId, command));
  await chmod(script, 0o755);
  try {
    await execFileAsync("open", [script]);
    result.launched = true;
  } catch (e) {
    result.reason = (e as Error).message;
  }
  return result;
}
