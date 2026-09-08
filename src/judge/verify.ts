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
import type { FindingConsensus } from "../backlog/consensus.js";
import { readingInstructionFor } from "./adapters.js";
import { pieceLines, preparePieces, type Pieces } from "./manifest.js";
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
import { scrollerLine, signalsLine } from "./signals-line.js";
import { measuredBrief } from "./measured.js";
import { problemLapses, withPlainHalf } from "../backlog/prose.js";
import { closeCall, narrating, openCall, say } from "../report/narration.js";

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
  /**
   * What the second judge said, when there was one.
   *
   * Carried on the judge's own shape rather than only in the backlog because
   * the ledger stores these findings whole: without it a cached verdict would
   * come back looking unanimous when it was contested.
   */
  consensus?: FindingConsensus;
}

/** A confirmed finding whose problem the refuter opened with a sentence a person can follow. */
export interface RepairedFinding {
  shotId: string;
  category: string;
  attribute: string;
  title: string;
  judge?: string;
  plain: string;
}

/** One acceptance criterion the refuter could not let stand, and why. */
export interface DroppedCriterion {
  shotId: string;
  category: string;
  attribute: string;
  judge?: string;
  text: string;
  reason: "undecidable-from-pixels" | "passes-on-the-defective-shot";
  /** The observable replacement the refuter supplied, when it could. */
  rewrite?: string;
}

export interface VerifyResult {
  confirmed: VerifiedFinding[];
  /**
   * Criteria dropped or rewritten at filing time.
   *
   * A criterion that cannot be decided from a screenshot does not fail a
   * verify-fix: it comes back not-verifiable, blocks nothing, and quietly
   * degrades the ruling to "the defect was not re-filed". Catching it here
   * costs nothing, because the refuter is already reading this finding and
   * this shot.
   */
  droppedCriteria: DroppedCriterion[];
  /** The plain halves the refuter supplied, so the panel that skipped them can learn. */
  repaired: RepairedFinding[];
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
  pieces?: Pieces,
  /**
   * What the project declared (its never-file lines, its design direction),
   * for the skill's own section. "" is a legitimate value: the heading stands
   * and says nothing is declared.
   */
  declared = "",
): string {
  const groups = groupShots([...shotsById.values()]);
  // Where each shot's primary sits, so a sibling can point at it by index
  // instead of repeating a claim the refuter is already reading.
  const primaryIndex = new Map<string, number>();
  findings.forEach((f, i) => {
    if (!f.siblingOf) primaryIndex.set(`${f.shotId}|${f.category}|${f.attribute}`, i);
  });
  const lines = findings.map((f, i) => {
    const shot = shotsById.get(f.shotId);
    const members = shot ? groups.get(viewGroupId(shot)) ?? [] : [];
    const evidence = members.flatMap((m) => [
      `     - ${evidenceDir}/${m.path}  (${m.formFactor}, ${m.scheme}` +
        (m.id === f.shotId ? ", the shot this was filed on)" : ")"),
      // A tall member is read in pieces, like the judge read it.
      ...pieceLines(m, evidenceDir, pieces, "       "),
    ]);
    // A sibling is the same claim about a different shot, and it is ruled on
    // its OWN evidence: the judge said the defect is here too, and this is
    // where that is confirmed or killed. It prints short (the claim, not the
    // whole finding, and no view listing the primary already carries) so a
    // six-shot view does not spend six copies of one paragraph.
    if (f.siblingOf) {
      const of = primaryIndex.get(`${f.siblingOf}|${f.category}|${f.attribute}`);
      return [
        `#${i} shotId: ${f.shotId}`,
        `   file: ${shot ? `${evidenceDir}/${shot.path}` : "(missing)"}`,
        `   view: ${shot ? `${shot.route} ${shot.state} (${shot.formFactor}, ${shot.scheme})` : "(unknown)"}`,
        `   claim [${f.severity}/${f.category}/${f.attribute}]: ${f.title}`,
        `   the judge filed this on ${f.siblingOf}${of === undefined ? "" : ` (#${of})`} and says THIS shot shows the same defect.`,
        "   Rule on this shot: is the defect visible here? Refuting it here does not refute it there.",
      ].join("\n");
    }
    return [
      `#${i} shotId: ${f.shotId}`,
      `   file: ${shot ? `${evidenceDir}/${shot.path}` : "(missing)"}`,
      `   view: ${shot ? `${shot.route} ${shot.state}` : "(unknown)"}`,
      `   claim [${f.severity}/${f.category}/${f.attribute}]: ${f.title}`,
      `   problem: ${f.problem}`,
      `   expected: ${f.expected}`,
      `   observed: ${f.observed}`,
      // Numbered so a verdict can point at one. The refuter is the last
      // participant holding this finding and this screenshot together, which
      // makes it the only one that can say whether a criterion is decidable
      // before somebody spends a fix cycle discovering it is not.
      // Guarded because a finding can arrive from the ledger, which is JSON on
      // disk written by an older lookout: a verdict cached before acceptance
      // criteria existed has no array at all, and refute-on-read hands those
      // straight back to this prompt.
      ...((f.acceptance ?? []).length > 0
        ? ["   acceptance criteria:", ...f.acceptance.map((c, n) => `     ${n + 1}. ${c}`)]
        : []),
      // What lookout measured about this shot, which is the one kind of number
      // in this prompt that was not written by a model. A refuter told to lean
      // refuted when uncertain will kill a real defect it cannot see in a
      // still; these are the facts that settle several of those either way.
      ...(shot && signalsLine(shot, 6) ? [`   measured on this shot: ${signalsLine(shot, 6)}`] : []),
      // Whether anything in the frame scrolls, which is the difference between
      // content a reader can reach and content that is gone. A refuter that
      // cannot tell them apart guesses, and guessing here kills real defects.
      ...(shot && scrollerLine(shot) ? [`   measured: something in this view ${scrollerLine(shot)}`] : []),
      ...(shot && measuredBrief(shot, evidenceDir)
        ? [`   measured: ${measuredBrief(shot, evidenceDir)}`]
        : []),
      // Only worth saying when there is more than the shot itself to look at.
      ...(evidence.length > 1 ? ["   every shot of this view:", ...evidence] : []),
    ].join("\n");
  });
  return renderSkill(skillText, { findings: lines.join("\n"), declared, howToOpen: readingInstructionFor() });
}

export async function verifyFindings(
  skillText: string,
  findings: AiFinding[],
  shotsById: Map<string, ShotRecord>,
  evidenceDir: string,
  model: string,
  /** Whose incident log a refuter failure belongs in. */
  projectDir?: string,
  /** What the project declared; see buildRefutePrompt. */
  declared = "",
): Promise<VerifyResult> {
  const serious = findings.filter(needsRefuting);
  const rest: VerifiedFinding[] = findings
    .filter((f) => !needsRefuting(f))
    .map((f) => ({ ...f, verified: false }));
  if (serious.length === 0) {
    return { confirmed: rest, refuted: [], repaired: [], droppedCriteria: [] };
  }

  const prompt = buildRefutePrompt(skillText, serious, shotsById, evidenceDir, await preparePieces(evidenceDir, [...shotsById.values()]), declared);

  // The same one-retry the judge gets: a model that wraps its JSON in prose
  // is still answering, and one that fails twice is recorded rather than
  // silently shrugged off. The refuter used to have neither, so the judge's
  // failure was an incident and the refuter's was invisible.
  let verdicts: {
    index: number;
    verdict: string;
    note?: string;
    plain?: string;
    criteria?: { n?: number; verdict?: string; rewrite?: string }[];
  }[] = [];
  let costUsd = 0;
  let parsedOk = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = openCall("refuter", `weighing ${serious.length} finding(s)`);
    // In a finally: a refuter that throws must still be seen to stop, or the
    // page pulses at it for as long as the tab is open.
    let res: Awaited<ReturnType<typeof invokeClaude>>;
    try {
      res = await invokeClaude({
        prompt: attempt === 0 ? prompt : prompt + RETRY_SUFFIX,
        model,
        onSay: narrating() ? (s) => say(call, "refuter", s) : undefined,
      });
    } finally {
      closeCall(call, "refuter");
    }
    costUsd += res.costUsd ?? 0;
    try {
      const parsed = extractJson(res.text) as { verdicts?: unknown };
      if (Array.isArray(parsed.verdicts)) {
        verdicts = parsed.verdicts as typeof verdicts;
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
          project: projectDir,
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
      repaired: [],
      droppedCriteria: [],
      costUsd,
    };
  }

  const confirmed: VerifiedFinding[] = [...rest];
  const refuted: (AiFinding & { verifierNote: string })[] = [];
  const repaired: RepairedFinding[] = [];
  const droppedCriteria: DroppedCriterion[] = [];
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
    const verified = v?.verdict === "confirmed";
    // The refuter's plain sentence goes above the judge's text, and only when
    // the judge's text needed one: a finding whose problem already opens with
    // a sentence a person can follow keeps it as written, and a sentence that
    // fails the same bar is not adopted. Never in place of the judge's words.
    let problem = f.problem;
    if (verified && typeof v?.plain === "string" && problemLapses(f).length > 0) {
      const composed = withPlainHalf(f.problem, v.plain, f.title, f.attribute);
      if (composed) {
        problem = composed;
        // Recorded on the primary only. A sibling carries its primary's prose,
        // so counting each one would report a single badly written problem as
        // four and teach the panel a lesson four times the size of its cause.
        if (!f.siblingOf) {
          repaired.push({ shotId: f.shotId, category: f.category, attribute: f.attribute, title: f.title, ...(f.judge ? { judge: f.judge } : {}), plain: v.plain.trim() });
        }
      }
    }
    // Criteria the refuter could not let stand. A criterion that no screenshot
    // can settle blocks nothing downstream and silently degrades a verify-fix
    // to "the defect was not re-filed"; one already true on the defective shot
    // would read as met while the defect stood. Both are better replaced or
    // dropped here, where the evidence is still in hand. A finding left with
    // none falls back to `expected`, which the rubric requires be checkable
    // from the pixels for exactly this reason.
    let acceptance = f.acceptance;
    if (verified && Array.isArray(v?.criteria) && (f.acceptance ?? []).length > 0) {
      const ruling = new Map<number, { verdict?: string; rewrite?: string }>();
      for (const c of v.criteria) {
        if (typeof c?.n === "number") ruling.set(c.n, { verdict: c.verdict, rewrite: c.rewrite });
      }
      acceptance = f.acceptance.flatMap((text, i) => {
        const r = ruling.get(i + 1);
        if (!r || r.verdict === "stands" || r.verdict === undefined) return [text];
        if (r.verdict !== "undecidable-from-pixels" && r.verdict !== "passes-on-the-defective-shot") {
          return [text];
        }
        const rewrite = typeof r.rewrite === "string" ? r.rewrite.trim().slice(0, 300) : "";
        droppedCriteria.push({
          shotId: f.shotId,
          category: f.category,
          attribute: f.attribute,
          ...(f.judge ? { judge: f.judge } : {}),
          text,
          reason: r.verdict,
          ...(rewrite ? { rewrite } : {}),
        });
        // A rewrite is preferred over a drop: the judge had something to say
        // and only said it unobservably.
        return rewrite && r.verdict === "undecidable-from-pixels" ? [rewrite] : [];
      });
    }
    confirmed.push({ ...f, problem, acceptance, verified, verifierNote: v?.note });
  });
  return { confirmed, refuted, repaired, droppedCriteria, costUsd };
}
