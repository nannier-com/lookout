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
import { ReplyStream, type JudgeSay, type ResultLine } from "./stream.js";
import { LookoutError } from "../types.js";

export interface JudgeInvocation {
  prompt: string;
  cwd: string;
  model: string;
  timeoutMs?: number;
  /**
   * What the subprocess may do. Read-only by default, which is what every
   * judging path wants: an oracle that can edit is not an oracle. `self-heal`
   * is the one caller that widens it, and it still withholds Bash, because
   * lookout runs the gates itself rather than trusting the reply.
   */
  allowedTools?: string[];
  /**
   * Called as the model works, if the caller wants to watch.
   *
   * Supplying one also asks the CLI for its reply token by token rather than
   * turn by turn, which is only worth the traffic when somebody is reading it.
   */
  onSay?: (say: JudgeSay) => void;
}

/**
 * The claude binary: overridable for nonstandard install paths and for test
 * doubles. The judge otherwise assumes `claude` on PATH, logged in (run
 * `claude` interactively once; `lookout doctor --handshake` verifies).
 */
export function claudeBin(): string {
  return process.env.LOOKOUT_CLAUDE_BIN ?? "claude";
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
    (inv.allowedTools ?? ["Read"]).join(","),
    "--model",
    inv.model,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd: inv.cwd, stdio: ["ignore", "pipe", "pipe"] });
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
