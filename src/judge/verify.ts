/**
 * Adversarial verification: a second, independent `claude -p` pass whose
 * explicit mandate is to REFUTE a finding against the same evidence. Findings
 * that survive are marked verified; refuted ones are dropped from the results
 * (kept in the report for transparency). In practice roughly a quarter of
 * serious findings do not survive it.
 *
 * What gets verified follows RISK, not severity alone. Severity says how much a
 * defect costs if it is real; it says nothing about how likely the judge was to
 * be wrong. The design-quality categories are the ones most easily argued into
 * existence, because they rest on a principle rather than on something plainly
 * broken, so they are refuted at every severity. A critical render failure and a
 * low-severity claim about hierarchy are both worth a second opinion, for
 * opposite reasons.
 */
import type { ShotRecord } from "../types.js";
import { renderSkill } from "../skills/load.js";
import { extractJson, invokeClaude, groupShots, viewGroupId, type AiFinding } from "./engine.js";

/**
 * Categories whose findings rest on a named principle rather than on something
 * visibly broken. These are the judge's most valuable output and its most
 * refutable: "no clear entry point for the eye" is a real defect when it is
 * true and taste dressed up as a principle when it is not, and only a second
 * look can tell the difference.
 */
const QUALITY_BAND = new Set([
  "hierarchy",
  "composition",
  "spacing",
  "typography",
  "alignment",
  "consistency",
]);

/** Whether a finding is worth a refuting pass: serious, or easily argued. */
export function needsRefuting(f: AiFinding): boolean {
  return f.severity === "critical" || f.severity === "high" || QUALITY_BAND.has(f.category);
}

export interface VerifiedFinding extends AiFinding {
  verified: boolean;
  verifierNote?: string;
}

export interface VerifyResult {
  confirmed: VerifiedFinding[];
  refuted: (AiFinding & { verifierNote: string })[];
  costUsd?: number;
}

/**
 * What the refuter is asked, with the whole view attached.
 *
 * The rubric has the judge compare a view's dark/light pair and its form-factor
 * progression, so a colour-scheme or responsive finding is a claim ABOUT that
 * comparison. The refuter used to be handed the single shot the finding was
 * filed on and told to lean refuted when uncertain, so the findings that needed
 * the most evidence were given the least and died for want of the partner shot
 * that would have settled them either way.
 */
export function buildRefutePrompt(
  skillText: string,
  findings: AiFinding[],
  shotsById: Map<string, ShotRecord>,
  evidenceDir: string,
): string {
  const groups = groupShots([...shotsById.values()]);
  const lines = findings.map((f, i) => {
    const shot = shotsById.get(f.shotId);
    const members = shot ? groups.get(viewGroupId(shot)) ?? [] : [];
    const evidence = members.map(
      (m) =>
        `     - ${evidenceDir}/${m.path}  (${m.formFactor}, ${m.scheme}` +
        (m.id === f.shotId ? ", the shot this was filed on)" : ")"),
    );
    return [
      `#${i} shotId: ${f.shotId}`,
      `   file: ${shot ? `${evidenceDir}/${shot.path}` : "(missing)"}`,
      `   view: ${shot ? `${shot.route} ${shot.state}` : "(unknown)"}`,
      `   claim [${f.severity}/${f.category}/${f.attribute}]: ${f.title}`,
      `   problem: ${f.problem}`,
      `   expected: ${f.expected}`,
      `   observed: ${f.observed}`,
      // Only worth saying when there is more than the shot itself to look at.
      ...(evidence.length > 1 ? ["   every shot of this view:", ...evidence] : []),
    ].join("\n");
  });
  return renderSkill(skillText, { findings: lines.join("\n") });
}

export async function verifyFindings(
  skillText: string,
  findings: AiFinding[],
  shotsById: Map<string, ShotRecord>,
  evidenceDir: string,
  model: string,
): Promise<VerifyResult> {
  const serious = findings.filter(needsRefuting);
  const rest: VerifiedFinding[] = findings
    .filter((f) => !needsRefuting(f))
    .map((f) => ({ ...f, verified: false }));
  if (serious.length === 0) {
    return { confirmed: rest, refuted: [] };
  }

  const prompt = buildRefutePrompt(skillText, serious, shotsById, evidenceDir);

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
      return;
    }
    // Only an explicit "confirmed" earns the flag. Anything else, a verdict the
    // verifier hedged, a word not in the contract, or no row at all, means the
    // finding stands but nothing checked it, and `verified` is the field that
    // says which of those happened.
    confirmed.push({ ...f, verified: v?.verdict === "confirmed", verifierNote: v?.note });
  });
  return { confirmed, refuted, costUsd: res.costUsd };
}
