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
import {
  extractJson,
  invokeClaude,
  groupShots,
  viewGroupId,
  RETRY_SUFFIX,
  type AiFinding,
} from "./engine.js";
import { recordIncident } from "../skills/incidents.js";
import { mark, narrating, say } from "../report/narration.js";

/**
 * Whether a finding is worth a refuting pass. Every AI finding is.
 *
 * There used to be a boundary here: critical and high always, plus six
 * design-quality categories at any severity, on the theory that a minor
 * claim about something plainly broken needed no second look. The rubric's
 * own ladder contradicted it: low is defined as "a named principle broken",
 * which makes every low finding exactly the arguable kind, and the boundary
 * left design-parity ("you judged the hand-off the better of the two") and
 * the comparative categories color-scheme and responsive, the ones the
 * refuter was given whole-view evidence FOR, unrefuted at medium and low.
 *
 * Widening costs no extra subprocess: the refuter already runs once per
 * judged batch, and this predicate only decided which findings rode along.
 * The function stays because it is the single choke point, and the place the
 * next boundary argument belongs if one ever returns.
 */
export function needsRefuting(_f: AiFinding): boolean {
  return true;
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

  // The same one-retry the judge gets: a model that wraps its JSON in prose
  // is still answering, and one that fails twice is recorded rather than
  // silently shrugged off. The refuter used to have neither, so the judge's
  // failure was an incident and the refuter's was invisible.
  let verdicts: { index: number; verdict: string; note?: string }[] = [];
  let costUsd = 0;
  let parsedOk = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    mark("refuter", "open", `weighing ${serious.length} finding(s)`);
    const res = await invokeClaude({
      prompt: attempt === 0 ? prompt : prompt + RETRY_SUFFIX,
      cwd: evidenceDir,
      model,
      onSay: narrating() ? (s) => say("refuter", s) : undefined,
    });
    mark("refuter", "close", "");
    costUsd += res.costUsd ?? 0;
    try {
      const parsed = extractJson(res.text) as { verdicts?: unknown };
      if (Array.isArray(parsed.verdicts)) {
        verdicts = parsed.verdicts as { index: number; verdict: string; note?: string }[];
      }
      parsedOk = true;
      break;
    } catch {
      if (attempt === 1) {
        recordIncident({
          at: new Date().toISOString(),
          kind: "judge-unparseable",
          verb: "check",
          message: "refuter: reply was not parseable JSON after a retry",
          detail: res.text.slice(0, 1000),
        });
      }
    }
  }
  if (!parsedOk) {
    // Unparseable verifier output: keep every serious finding, unverified,
    // rather than silently dropping defects.
    return {
      confirmed: [...serious.map((f) => ({ ...f, verified: false })), ...rest],
      refuted: [],
      costUsd,
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
  return { confirmed, refuted, costUsd };
}
