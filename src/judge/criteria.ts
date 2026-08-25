/**
 * Acceptance-criteria verification: turn ticket text into per-criterion
 * verdicts grounded in captured evidence. Extraction and judgment happen in
 * one `claude -p` round-trip: the model reads the ticket, decides what is
 * visually testable, reads the screenshots, and rules on each criterion.
 */
import { LookoutError, type ShotRecord } from "../types.js";
import { extractJson, invokeClaude } from "./engine.js";

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
  project: string,
  criteriaText: string,
  shots: ShotRecord[],
  evidenceDir: string,
): string {
  const manifest = shots
    .map(
      (s) =>
        `- shotId: ${s.id}\n  file: ${evidenceDir}/${s.path}\n  route: ${s.route}  state: ${s.state}  formFactor: ${s.formFactor}  scheme: ${s.scheme}  size: ${s.width}x${s.height}`,
    )
    .join("\n");
  return [
    `You are lookout's acceptance-criteria verifier for the project "${project}".`,
    `Below is a ticket (or acceptance-criteria text) and a set of screenshots of the running app.`,
    ``,
    `Step 1: extract the discrete, checkable criteria from the ticket. Split compound`,
    `sentences; keep each criterion atomic. Number them from 1.`,
    `Step 2: read every screenshot with the Read tool.`,
    `Step 3: rule on each criterion strictly from the evidence:`,
    `  - "pass": the screenshots demonstrably show it satisfied. Cite the shotIds.`,
    `  - "fail": the screenshots demonstrably show it violated. Cite the shotIds.`,
    `  - "not-verifiable": the evidence cannot decide it (wrong route, needs`,
    `    interaction or data you cannot see, non-visual behavior like an API call).`,
    `    Say exactly what evidence would decide it.`,
    `Never rule pass on faith: no evidence means not-verifiable, not pass.`,
    `Step 4: where you see an easy improvement related to a criterion (visual or UX),`,
    `add a one-line suggestion. Suggestions are optional and never affect verdicts.`,
    ``,
    `=== TICKET ===`,
    criteriaText,
    `=== END TICKET ===`,
    ``,
    `=== SHOTS (${shots.length}) ===`,
    manifest,
    `=== END SHOTS ===`,
    ``,
    `Reply with ONLY a fenced json block:`,
    "```json",
    `{`,
    `  "criteria": [`,
    `    { "id": 1, "text": "<criterion>", "verdict": "pass | fail | not-verifiable",`,
    `      "reasoning": "<what the evidence shows>", "evidence": ["<shotId>"],`,
    `      "suggestion": "<optional one-liner>" }`,
    `  ],`,
    `  "summary": "<one sentence: N pass, N fail, N not verifiable>"`,
    `}`,
    "```",
  ].join("\n");
}

export async function verifyCriteria(
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

  const prompt = buildVerifyPrompt(project, criteriaText, shots, evidenceDir);
  const res = await invokeClaude({ prompt, cwd: evidenceDir, model });

  let parsed: { criteria?: unknown; summary?: unknown };
  try {
    parsed = extractJson(res.text) as { criteria?: unknown; summary?: unknown };
  } catch {
    throw new LookoutError(
      "criteria verifier reply was not parseable JSON",
      `reply head: ${res.text.slice(0, 200)}`,
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
    costUsd: res.costUsd,
    raw: res.text,
  };
}
