/**
 * Talking to the Codex CLI, and getting an answer back out.
 *
 * The second judging adapter, and the one that proved the interface was worth
 * having: almost nothing it does resembles what the Claude adapter does. It is
 * a subcommand rather than a flag, it opens a screenshot with a differently
 * named tool, it reports what it spent in tokens rather than dollars, and its
 * event stream uses a vocabulary of its own.
 *
 * Four things about this CLI are load-bearing and each was established by
 * running it rather than by reading about it:
 *
 *   stdin      it reads stdin when stdin is open, and waits for end of file
 *              that may never come. A first attempt hung indefinitely on
 *              exactly this. `stdio: ["ignore", …]` is not tidiness.
 *   git        `exec` refuses to run outside a repository, and the judge runs
 *              in a scratch directory on purpose (`judgeCwd`), so
 *              `--skip-git-repo-check` is required rather than defensive.
 *   the answer `--output-last-message` writes the final message to a file, so
 *              the verdict does not depend on parsing the stream at all. The
 *              stream is read for narration, and narration going quiet is a
 *              cosmetic failure rather than a lost verdict.
 *   the reads  its stream does NOT report opening an image. Measured: a run
 *              that demonstrably looked at a screenshot and described it
 *              correctly emitted only `agent_message` items. So `reportsReads`
 *              is false, and lookout turns the clean-without-looking check OFF
 *              for this adapter and says it did, rather than concluding every
 *              shot went unread and re-judging the same batch forever.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { judgeCwd } from "./claude.js";
import { cliVersion } from "./cli-probe.js";
import type { AiAdapter, JudgeInvocation, JudgeReply, Spend } from "./ai-types.js";
import type { CliFacts } from "./cli-probe.js";
import { have } from "../util.js";
import { LookoutError } from "../types.js";

const TIMEOUT_MS = 10 * 60_000;
const MAX_STDERR = 4000;

/** Where this CLI keeps its config, its auth and its model cache. */
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/**
 * The codex binary, which is frequently not on PATH.
 *
 * An ordered list rather than one path, and an environment variable ahead of
 * all of it, because this CLI installs itself somewhere its own plugin manager
 * chooses and that location can move between releases. A moved path is then
 * data rather than a bug, and `LOOKOUT_CODEX_BIN` is the answer for an install
 * that lands somewhere nobody predicted.
 */
export async function codexBin(): Promise<string | null> {
  const override = process.env.LOOKOUT_CODEX_BIN;
  if (override) return override;
  if (await have("codex")) return "codex";
  const candidates = [
    join(codexHome(), "plugins", ".plugin-appserver", "codex"),
    join(codexHome(), "bin", "codex"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * The models this install offers, filtered to the ones that can do the job.
 *
 * Two filters, not one. `visibility` is the CLI's own answer to "should a
 * picker show this", and `input_modalities` is the difference between a model
 * that can judge a screenshot and one that cannot: this install lists a
 * text-only model among its visible ones, and the CLI itself refuses an image
 * to it. Offering it in a menu of judges would be offering a judge that cannot
 * see, so lookout asks the same question the CLI would and leaves it out.
 */
export function codexModels(home = codexHome()): string[] {
  const p = join(home, "models_cache.json");
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      models?: { slug?: string; visibility?: string; priority?: number; input_modalities?: string[] }[];
    };
    return (raw.models ?? [])
      .filter((m) => m.visibility === "list" && (m.input_modalities ?? []).includes("image") && m.slug)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m) => m.slug!);
  } catch {
    return [];
  }
}

/** Its version and its models, asked of the install rather than stated here. */
async function probe(): Promise<CliFacts> {
  const bin = await codexBin();
  if (!bin) return { version: null, models: [] };
  return { version: await cliVersion(bin), models: codexModels() };
}

/** The last thing the model said, from the stream, when the file has nothing. */
function lastMessage(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const d = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } };
      if (d.type === "item.completed" && d.item?.type === "agent_message" && d.item.text) text = d.item.text;
    } catch {
      // A line that is not JSON is the CLI talking to a terminal. Dropping it
      // must never lose a verdict that has already been paid for.
    }
  }
  return text;
}

/** What the run cost, in the unit this CLI is willing to report: tokens. */
function spendOf(stdout: string): Spend | undefined {
  for (const line of stdout.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const d = JSON.parse(t) as { type?: string; usage?: Record<string, number> };
      if (d.type !== "turn.completed" || !d.usage) continue;
      const u = d.usage;
      return { tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Narrate the prose as it lands, for a page that is watching. */
function narrate(chunk: string, onSay: NonNullable<JudgeInvocation["onSay"]>): void {
  for (const line of chunk.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const d = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } };
      if (d.type === "item.completed" && d.item?.type === "agent_message" && d.item.text) {
        onSay({ kind: "text", text: d.item.text });
      }
    } catch {
      continue;
    }
  }
}

/** One `codex exec` round trip returning the reply text. */
export function invokeCodex(inv: JudgeInvocation): Promise<JudgeReply> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const bin = await codexBin();
      if (!bin) {
        reject(new LookoutError("codex is not installed here", "set LOOKOUT_CODEX_BIN, or put `codex` on PATH"));
        return;
      }
      // The final message goes to a file, so the verdict never depends on the
      // shape of the event stream. Its own directory, removed on the way out.
      const scratch = mkdtempSync(join(tmpdir(), "lookout-codex-"));
      const answerPath = join(scratch, "answer.txt");
      const args = [
        "exec",
        "--skip-git-repo-check",
        // The oracle judges pixels; it has no business loading the operator's
        // own config and MCP servers, which a first run demonstrably did.
        "--ignore-user-config",
        "-s",
        "read-only",
        "-m",
        inv.model,
        "--json",
        "--color",
        "never",
        "-o",
        answerPath,
        inv.prompt,
      ];
      const child = spawn(bin, args, {
        cwd: inv.cwd ?? judgeCwd(),
        // It reads stdin when stdin is open and waits for an end of file that
        // never comes. This is what stops it hanging.
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (err: LookoutError | null, value?: JudgeReply): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rmSync(scratch, { recursive: true, force: true });
        if (child.exitCode === null && !child.killed) child.kill();
        if (err) reject(err);
        else resolve(value!);
      };
      const timer = setTimeout(() => {
        done(
          new LookoutError(
            `codex exec failed: no reply after ${Math.round((inv.timeoutMs ?? TIMEOUT_MS) / 1000)}s`,
            stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Codex logged in? run `codex` once interactively",
          ),
        );
      }, inv.timeoutMs ?? TIMEOUT_MS);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (inv.onSay) narrate(chunk, inv.onSay);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk;
      });
      child.on("error", (err: Error) => {
        done(
          new LookoutError(
            `codex exec failed: ${err.message.slice(0, 300)}`,
            stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Codex logged in? run `codex` once interactively",
          ),
        );
      });
      // The answer file is written as the process ends, so unlike the Claude
      // adapter there is nothing to settle early on: waiting for exit IS the
      // contract here rather than a cost.
      child.on("exit", async (code) => {
        const spend = spendOf(stdout);
        let text = "";
        try {
          if (existsSync(answerPath)) text = (await readFile(answerPath, "utf8")).trim();
        } catch {
          // Fall through to the stream, which usually carries the same words.
        }
        if (!text) text = lastMessage(stdout);
        if (!text) {
          done(
            new LookoutError(
              code === 0
                ? `codex exec produced no reply: ${stdout.slice(0, 300)}`
                : `codex exec failed: exited ${code ?? "on a signal"}`,
              stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Codex logged in? run `codex` once interactively",
            ),
          );
          return;
        }
        // reads is empty and reportsReads is false: this CLI does not say what
        // it opened, and an empty list here means "not reported", never "none".
        done(null, { text, reads: [], ...(spend ? { spend } : {}) });
      });
    })();
  });
}

export const codexAdapter: AiAdapter = {
  key: "codex",
  label: "Codex",
  // No stable alias: this CLI names its models by slug and the slugs move, so
  // there is nothing to write here that would not be a guess. The empty string
  // means "the panel must offer a choice", and the settings row does.
  defaultModel: "",
  reportsReads: false,
  // Verified against the installed CLI: "View a local image file from the
  // filesystem when visual inspection is needed."
  readingInstruction: "with the view_image tool",
  bin: codexBin,
  probe,
  invoke: invokeCodex,
};
