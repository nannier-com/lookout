/**
 * `lookout ask "question"`: capture the relevant evidence, then answer the
 * question grounded in what the screenshots actually show. The fact-check
 * verb: an agent unsure whether its change worked, or whether an assumption
 * holds ("does the sidebar collapse below 640px?"), asks instead of guessing.
 *
 * Defaults: every form factor of the project's fold, dark only. Tablet is
 * where a two-column layout most often breaks, and the verb used to leave it
 * out; a scheme question is rarer than a layout one, so light stays one flag
 * away. Narrow with --viewports, widen with --schemes; --targets and --routes
 * scope as everywhere. Always exits 0 unless execution failed: an answer is
 * not a defect.
 */
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { DEFAULT_JUDGE_MODEL, invokeClaude } from "../judge/engine.js";
import { manifestOf, preparePieces } from "../judge/manifest.js";
import { loadSkill, renderSkill } from "../skills/load.js";
import { LookoutError, type Scheme } from "../types.js";
import { printJson, str, type Parsed } from "../util.js";
import { runCapture } from "./capture.js";

/** What a question is photographed in when no flag says: one scheme, every form factor. */
export const ASK_DEFAULT_SCHEMES: readonly Scheme[] = ["dark"];

/**
 * The flags a question runs with: the caller's, with the scheme defaulted to
 * dark when none was named. Form factors are deliberately left alone, so the
 * capture default (every form factor) rules; the verb used to narrow them to
 * desktop and phone and never said so.
 */
export function askFlags(flags: Parsed["flags"]): Parsed["flags"] {
  return flags.schemes === undefined ? { ...flags, schemes: ASK_DEFAULT_SCHEMES.join(",") } : flags;
}

export async function ask(parsed: Parsed): Promise<number> {
  const question = parsed.positionals.join(" ").trim();
  if (!question) {
    throw new LookoutError(
      'ask needs a question, e.g. lookout ask "is the sidebar collapsed at phone width?"',
    );
  }

  const { resolved } = await runCapture({ ...parsed, flags: askFlags(parsed.flags) });
  const { loadReport } = await import("../capture/store.js");
  const report = await loadReport(resolved);
  if (!report) throw new LookoutError("capture produced no report");

  // Only this run's shots ground the answer: stale evidence answers nothing.
  const latestRun = report.runs[report.runs.length - 1]!;
  const shots = report.shots.filter((s) => s.runId === latestRun.id);
  if (shots.length === 0) throw new LookoutError("no shots captured for the question's scope");

  const evDir = evidenceDir(resolved);
  const manifest = manifestOf(shots, evDir, await preparePieces(evDir, shots));

  const skill = await loadSkill(resolved, "fact-check");
  const prompt = renderSkill(skill.text, {
    project: resolved.project,
    question,
    shotCount: shots.length,
    manifest,
  });

  const model = str(parsed.flags.model) ?? DEFAULT_JUDGE_MODEL;
  const res = await invokeClaude({ prompt, model });

  if (parsed.flags.json) {
    printJson({
      question,
      answer: res.text,
      shots: shots.map((s) => ({ id: s.id, path: join(evDir, s.path) })),
      costUsd: res.costUsd,
    });
  } else {
    console.log(`\n${res.text}\n`);
    console.log(`evidence: ${evDir} (${shots.length} shot(s))`);
  }
  return 0;
}
