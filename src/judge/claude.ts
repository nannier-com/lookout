/**
 * Talking to the Claude Code CLI, and getting an answer back out.
 *
 * Every AI capability lookout has goes through here: the judge, the refuter,
 * the acceptance verifier, the conformance reader, the skill amender and the
 * healer. What they share is not what they ask but how they ask it, which is
 * why this is its own module: one subprocess contract, one place that knows how
 * a reply is unwrapped, and one place to change when the CLI's envelope moves.
 *
 * `extractJson` is deliberately forgiving in one direction only. A model that
 * wraps its JSON in prose or a fence is still answering; a model that answers
 * something else is not, and that must fail rather than be guessed at.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplyStream, type ResultLine } from "./stream.js";
import { probeCli, type CliFacts } from "./cli-probe.js";
import type { AiAdapter, Capability, JudgeInvocation, JudgeReply } from "./ai-types.js";
import { LookoutError } from "../types.js";

export type { JudgeInvocation };

/**
 * The model lookout judges with when nobody has said otherwise.
 *
 * One name because the page now offers to change it, and a panel that reports
 * a default the verbs do not share would be reporting a guess. Every path that
 * takes a `--model` flag falls back to this, so the answer the settings panel
 * shows is the answer the next run uses.
 */
export const DEFAULT_JUDGE_MODEL = "sonnet";


/**
 * What this CLI calls the things lookout asks for.
 *
 * The mapping lives here rather than at the call sites because "let it read the
 * files I name" is a request every judging path makes and only this file should
 * know that Claude Code spells it `Read`. The name is load-bearing beyond the
 * flag: the stream reader watches for tool calls by this name to build the list
 * of files the model actually opened.
 */
const TOOLS: Record<Capability, string[]> = {
  "read-files": ["Read"],
  "search-files": ["Grep", "Glob"],
  "edit-files": ["Edit", "Write"],
};

/** The tool names for a set of capabilities, deduplicated and ordered. */
export function claudeTools(caps: readonly Capability[]): string[] {
  return [...new Set(caps.flatMap((c) => TOOLS[c]))];
}

/**
 * The claude binary: overridable for nonstandard install paths and for test
 * doubles. The judge otherwise assumes `claude` on PATH, logged in (run
 * `claude` interactively once; `lookout doctor --handshake` verifies).
 */
export function claudeBin(): string {
  return process.env.LOOKOUT_CLAUDE_BIN ?? "claude";
}

/**
 * A scratch directory for the subprocess to run in, made once per process.
 *
 * The CLI reads instructions from its working directory upwards: a cwd inside
 * the judged repository would hand the oracle that project's `CLAUDE.md`, its
 * `.claude/settings.json` and its hooks, and let `Read` climb into its source.
 * The evidence used to be outside every project, so pinning the judge to it was
 * enough on its own; now that the workspace lives in the project, the isolation
 * has to be asked for. Every path the prompt names is absolute, so the judge
 * loses nothing by standing somewhere empty.
 */
let scratch: string | null = null;
export function judgeCwd(): string {
  if (scratch) return scratch;
  scratch = mkdtempSync(join(tmpdir(), "lookout-judge-"));
  const dir = scratch;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return scratch;
}

/** How long to wait for a stalled CLI, and how long to let stdout drain after it exits. */
const TIMEOUT_MS = 10 * 60_000;
const DRAIN_MS = 250;
/** Enough stderr to carry the CLI's own complaint, and no more. */
const MAX_STDERR = 4000;

/**
 * One `claude -p` round-trip returning the reply text.
 *
 * The call completes on the CLI's own result message, not on the subprocess's
 * stdout reaching end-of-file. Those are different moments, and the difference
 * was expensive: anything that outlives the CLI holding the pipe it inherited
 * holds that end-of-file open too, and lookout waited behind it for the whole
 * timeout with the verdict already read. Runs were measured losing ten minutes
 * per judging phase to exactly that. Reading the stream means the end of the
 * answer is something lookout sees rather than something it waits for.
 */
export function invokeClaude(inv: JudgeInvocation): Promise<{ text: string; costUsd?: number; reads: string[] }> {
  const args = [
    "-p",
    inv.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // Only when somebody is reading: partials multiply the lines by an order of
    // magnitude and buy nothing for a caller that just wants the verdict.
    ...(inv.onSay ? ["--include-partial-messages"] : []),
    "--allowedTools",
    claudeTools(inv.capabilities ?? ["read-files"]).join(","),
    "--model",
    inv.model,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd: inv.cwd ?? judgeCwd(), stdio: ["ignore", "pipe", "pipe"] });
    const reply = new ReplyStream(inv.onSay);
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let drain: ReturnType<typeof setTimeout> | null = null;

    // Settling is one-way, and it does not wait for the pipes. A child that has
    // said its last word is done whether or not something else still holds its
    // stdout, so it is killed rather than waited on.
    const done = (err: LookoutError | null, value?: { text: string; costUsd?: number; reads: string[] }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drain) clearTimeout(drain);
      if (child.exitCode === null && !child.killed) child.kill();
      if (err) reject(err);
      else resolve(value!);
    };

    const conclude = (code: number | null): void => {
      reply.end();
      if (reply.result) {
        unwrap(reply.result, done, reply.reads);
        return;
      }
      if (code !== 0) {
        done(
          new LookoutError(
            `claude -p failed: exited ${code ?? "on a signal"}`,
            stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Claude Code logged in? run `claude` once interactively",
          ),
        );
        return;
      }
      done(new LookoutError(`claude -p produced unparseable output: ${reply.raw().slice(0, 300)}`));
    };

    timer = setTimeout(() => {
      done(
        new LookoutError(
          `claude -p failed: no reply after ${Math.round((inv.timeoutMs ?? TIMEOUT_MS) / 1000)}s`,
          stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Claude Code logged in? run `claude` once interactively",
        ),
      );
    }, inv.timeoutMs ?? TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      reply.push(chunk);
      // The whole point: the result line IS the end of the answer.
      if (reply.result) unwrap(reply.result, done, reply.reads);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.on("error", (err: Error) => {
      done(
        new LookoutError(
          `claude -p failed: ${err.message.slice(0, 300)}`,
          stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Claude Code logged in? run `claude` once interactively",
        ),
      );
    });
    // Only the failure paths reach here, and only they pay the drain: a reply
    // that arrived has already settled the call above.
    child.on("exit", (code) => {
      child.stdout?.once("end", () => conclude(code));
      drain = setTimeout(() => conclude(code), DRAIN_MS);
    });
  });
}

/** The result message, turned into an answer or into the reason there is none. */
function unwrap(
  r: ResultLine,
  done: (err: LookoutError | null, value?: { text: string; costUsd?: number; reads: string[] }) => void,
  reads: string[],
): void {
  if (typeof r.result !== "string") {
    done(new LookoutError(`claude -p returned no result (subtype: ${r.subtype ?? "?"})`));
    return;
  }
  if (r.is_error) {
    done(
      new LookoutError(
        `claude -p errored: ${r.result.slice(0, 200)}`,
        /not logged in/i.test(r.result)
          ? "run `claude` in a terminal once and complete /login, then retry (verify with `lookout doctor --handshake`)"
          : undefined,
      ),
    );
    return;
  }
  done(null, { text: r.result, costUsd: r.total_cost_usd, reads });
}

/** Extract the last fenced json block (or a bare object) from a reply. */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidate = fences.length > 0 ? fences[fences.length - 1]![1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * The judge prompt: the judge-core skill, filled with this batch's data.
 *
 * Everything the model is told to think lives in the skill file; everything
 * here is fact about the evidence.
 */
/** A defect already open against one of the views being judged. */

/**
 * Claude Code as one AI among others.
 *
 * `reportsReads` is true because the stream envelope names every tool call, so
 * lookout can tell a shot that was called clean after being opened from one
 * that was called clean without being looked at.
 */
export const claudeAdapter: AiAdapter = {
  key: "claude-code",
  label: "Claude Code",
  defaultModel: DEFAULT_JUDGE_MODEL,
  reportsReads: true,
  readingInstruction: "with the Read tool",
  bin: async () => claudeBin(),
  probe: (): Promise<CliFacts> => probeCli(claudeBin()),
  invoke: async (inv: JudgeInvocation): Promise<JudgeReply> => {
    const r = await invokeClaude(inv);
    return { text: r.text, reads: r.reads, ...(r.costUsd === undefined ? {} : { spend: { usd: r.costUsd } }) };
  },
};
