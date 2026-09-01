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
import { execFile } from "node:child_process";
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
}

/**
 * The claude binary: overridable for nonstandard install paths and for test
 * doubles. The judge otherwise assumes `claude` on PATH, logged in (run
 * `claude` interactively once; `lookout doctor --handshake` verifies).
 */
export function claudeBin(): string {
  return process.env.LOOKOUT_CLAUDE_BIN ?? "claude";
}

/** One `claude -p` round-trip returning the reply text. */
export function invokeClaude(inv: JudgeInvocation): Promise<{ text: string; costUsd?: number }> {
  const args = [
    "-p",
    inv.prompt,
    "--output-format",
    "json",
    "--allowedTools",
    (inv.allowedTools ?? ["Read"]).join(","),
    "--model",
    inv.model,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      args,
      { cwd: inv.cwd, timeout: inv.timeoutMs ?? 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new LookoutError(
              `claude -p failed: ${err.message.slice(0, 300)}`,
              stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Claude Code logged in? run `claude` once interactively",
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            result?: string;
            total_cost_usd?: number;
            is_error?: boolean;
            subtype?: string;
          };
          if (typeof parsed.result !== "string") {
            reject(new LookoutError(`claude -p returned no result (subtype: ${parsed.subtype ?? "?"})`));
            return;
          }
          if (parsed.is_error) {
            reject(
              new LookoutError(
                `claude -p errored: ${parsed.result.slice(0, 200)}`,
                /not logged in/i.test(parsed.result)
                  ? "run `claude` in a terminal once and complete /login, then retry (verify with `lookout doctor --handshake`)"
                  : undefined,
              ),
            );
            return;
          }
          resolve({ text: parsed.result, costUsd: parsed.total_cost_usd });
        } catch {
          reject(new LookoutError(`claude -p produced unparseable output: ${stdout.slice(0, 300)}`));
        }
      },
    );
  });
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
