/**
 * Acceptance-criteria verification: turn ticket text into per-criterion
 * verdicts grounded in captured evidence. Extraction and judgment happen in
 * one `claude -p` round-trip: the model reads the ticket, decides what is
 * visually testable, reads the screenshots, and rules on each criterion.
 */
import { LookoutError, type ShotRecord } from "../types.js";
import { manifestOf, preparePieces, type Pieces } from "./manifest.js";
import { renderSkill } from "../skills/load.js";
import { extractJson, invokeClaude, RETRY_SUFFIX } from "./engine.js";

export type CriterionVerdict = "pass" | "fail" | "not-verifiable";

export interface CriterionResult {
  id: number;
  text: string;
  verdict: CriterionVerdict;
  reasoning: string;
  evidence: string[]; // shotIds
  suggestion?: string;
}

export interface VerifyCriteriaResult {
  criteria: CriterionResult[];
  summary: string;
  costUsd?: number;
  raw: string;
}

/** Verdicts need the full evidence set in one context; cap it predictably. */
export const MAX_VERIFY_SHOTS = 20;

export function buildVerifyPrompt(
  skillText: string,
  project: string,
  criteriaText: string,
  shots: ShotRecord[],
  evidenceDir: string,
  pieces?: Pieces,
): string {
  const manifest = manifestOf(shots, evidenceDir, pieces);
  return renderSkill(skillText, {
    project,
    criteria: criteriaText,
    shotCount: shots.length,
    manifest,
  });
}

export async function verifyCriteria(
  skillText: string,
  project: string,
  criteriaText: string,
  shots: ShotRecord[],
  evidenceDir: string,
  model: string,
): Promise<VerifyCriteriaResult> {
  if (shots.length === 0) throw new LookoutError("no evidence captured for the criteria scope");
  if (shots.length > MAX_VERIFY_SHOTS) {
    throw new LookoutError(
      `${shots.length} shots exceed the verify cap of ${MAX_VERIFY_SHOTS}`,
      "narrow the scope with --targets/--routes/--viewports/--schemes so all evidence fits one judgment",
    );
  }

  const prompt = buildVerifyPrompt(skillText, project, criteriaText, shots, evidenceDir, await preparePieces(evidenceDir, shots));

  // The same one-retry the judge and the refuter get: an unruled criterion
  // refuses a pass downstream, so a reply that merely wrapped its JSON in
  // prose should not be the reason a verify-fix comes back not-ruled.
  let parsed: { criteria?: unknown; summary?: unknown } | null = null;
  let text = "";
  let costUsd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await invokeClaude({
      prompt: attempt === 0 ? prompt : prompt + RETRY_SUFFIX,
      cwd: evidenceDir,
      model,
    });
    text = res.text;
    costUsd = (costUsd ?? 0) + (res.costUsd ?? 0);
    try {
      parsed = extractJson(res.text) as { criteria?: unknown; summary?: unknown };
      break;
    } catch {
      // fall through to the retry, then to the error below
    }
  }
  if (!parsed) {
    throw new LookoutError(
      "criteria verifier reply was not parseable JSON after a retry",
      `reply head: ${text.slice(0, 200)}`,
    );
  }

  const known = new Set(shots.map((s) => s.id));
  const criteria: CriterionResult[] = [];
  for (const c of Array.isArray(parsed.criteria) ? parsed.criteria : []) {
    const r = c as Record<string, unknown>;
    const verdict = String(r.verdict ?? "");
    if (!["pass", "fail", "not-verifiable"].includes(verdict)) continue;
    criteria.push({
      id: Number(r.id ?? criteria.length + 1),
      text: String(r.text ?? "").slice(0, 500),
      verdict: verdict as CriterionVerdict,
      reasoning: String(r.reasoning ?? "").slice(0, 1000),
      evidence: (Array.isArray(r.evidence) ? r.evidence : []).map(String).filter((id) => known.has(id)),
      suggestion: typeof r.suggestion === "string" && r.suggestion.trim() ? r.suggestion.slice(0, 300) : undefined,
    });
  }
  if (criteria.length === 0) {
    throw new LookoutError(
      "the verifier extracted no checkable criteria from the ticket",
      "check the --criteria text; pure behavioral or backend criteria cannot be judged visually",
    );
  }

  return {
    criteria,
    summary: String(parsed.summary ?? "").slice(0, 300),
    costUsd,
    raw: text,
  };
}
