/**
 * `lookout ask "question"`: capture the relevant evidence, then answer the
 * question grounded in what the screenshots actually show. The fact-check
 * verb: an agent unsure whether its change worked, or whether an assumption
 * holds ("does the sidebar collapse below 640px?"), asks instead of guessing.
 *
 * Defaults are lighter than a sweep: desktop + phone, dark only. Narrow the
 * scope with the usual flags (--targets, --routes, --viewports, --schemes).
 * Always exits 0 unless execution failed: an answer is not a defect.
 */
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { invokeClaude } from "../judge/engine.js";
import { manifestOf, preparePieces } from "../judge/manifest.js";
import { loadSkill, renderSkill } from "../skills/load.js";
import { LookoutError } from "../types.js";
import { printJson, str, type Parsed } from "../util.js";
import { runCapture } from "./capture.js";

export async function ask(parsed: Parsed): Promise<number> {
  const question = parsed.positionals.join(" ").trim();
  if (!question) {
    throw new LookoutError(
      'ask needs a question, e.g. lookout ask "does the sidebar collapse below 640px?"',
    );
  }

  // Lighter default matrix for a question; explicit flags win.
  if (!parsed.flags.viewports) parsed.flags.viewports = "desktop,phone";
  if (!parsed.flags.schemes) parsed.flags.schemes = "dark";

  const { resolved } = await runCapture(parsed);
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

  const model = str(parsed.flags.model) ?? "sonnet";
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
