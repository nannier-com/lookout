/**
 * Adversarial verification: every critical/high finding gets a second,
 * independent `claude -p` pass whose explicit mandate is to REFUTE it against
 * the same evidence. Findings that survive are marked verified; refuted ones
 * are dropped from the results (kept in the report for transparency).
 * Experience from the canvas audits: roughly a quarter of serious findings
 * die under verification.
 */
import type { ShotRecord } from "../types.js";
import { extractJson, invokeClaude, type AiFinding } from "./engine.js";

export interface VerifiedFinding extends AiFinding {
  verified: boolean;
  verifierNote?: string;
}

export interface VerifyResult {
  confirmed: VerifiedFinding[];
  refuted: (AiFinding & { verifierNote: string })[];
  costUsd?: number;
}

export async function verifyFindings(
  findings: AiFinding[],
  shotsById: Map<string, ShotRecord>,
  evidenceDir: string,
  model: string,
): Promise<VerifyResult> {
  const serious = findings.filter((f) => f.severity === "critical" || f.severity === "high");
  const rest: VerifiedFinding[] = findings
    .filter((f) => f.severity !== "critical" && f.severity !== "high")
    .map((f) => ({ ...f, verified: false }));
  if (serious.length === 0) {
    return { confirmed: rest, refuted: [] };
  }

  const lines = serious.map((f, i) => {
    const shot = shotsById.get(f.shotId);
    return [
      `#${i} shotId: ${f.shotId}`,
      `   file: ${shot ? `${evidenceDir}/${shot.path}` : "(missing)"}`,
      `   claim [${f.severity}/${f.category}/${f.attribute}]: ${f.title}`,
      `   problem: ${f.problem}`,
      `   expected: ${f.expected}`,
      `   observed: ${f.observed}`,
    ].join("\n");
  });

  const prompt = [
    "You are lookout's adversarial verifier. Another judge filed the findings below",
    "against these screenshots. Your mandate is to try to REFUTE each one: re-read",
    "the screenshot with the Read tool and check whether the claimed defect is",
    "actually visible as described. A finding is refuted when the evidence does not",
    "show it, it misreads intended design (demo data, deliberate responsive",
    "collapse, reduced-motion stills), or the claim exaggerates a sub-pixel or",
    "rendering artifact. When the defect is plainly visible, confirm it and sharpen",
    "the description if you can. When uncertain, lean refuted: a false defect is",
    "worse than a missed nitpick.",
    "",
    "=== FINDINGS ===",
    lines.join("\n"),
    "=== END FINDINGS ===",
    "",
    "Reply with ONLY a fenced json block:",
    "```json",
    '{ "verdicts": [ { "index": 0, "verdict": "confirmed" | "refuted", "note": "<one line>" } ] }',
    "```",
  ].join("\n");

  const res = await invokeClaude({ prompt, cwd: evidenceDir, model });
  let verdicts: { index: number; verdict: string; note?: string }[] = [];
  try {
    const parsed = extractJson(res.text) as { verdicts?: unknown };
    if (Array.isArray(parsed.verdicts)) {
      verdicts = parsed.verdicts as { index: number; verdict: string; note?: string }[];
    }
  } catch {
    // Unparseable verifier output: keep every serious finding, unverified,
    // rather than silently dropping defects.
    return {
      confirmed: [...serious.map((f) => ({ ...f, verified: false })), ...rest],
      refuted: [],
      costUsd: res.costUsd,
    };
  }

  const confirmed: VerifiedFinding[] = [...rest];
  const refuted: (AiFinding & { verifierNote: string })[] = [];
  serious.forEach((f, i) => {
    const v = verdicts.find((x) => x.index === i);
    if (v && v.verdict === "refuted") {
      refuted.push({ ...f, verifierNote: v.note ?? "refuted" });
    } else {
      confirmed.push({ ...f, verified: !!v, verifierNote: v?.note });
    }
  });
  return { confirmed, refuted, costUsd: res.costUsd };
}
