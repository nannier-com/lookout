/**
 * Acceptance criteria: what would prove an issue is actually fixed.
 *
 * Every issue carries them from the moment it is filed, because "is it fixed"
 * is not a question anybody should be answering from memory of what the defect
 * looked like. They are written to be decidable from a screenshot of the same
 * view: an agent handed the issue reads the same list lookout will rule against.
 *
 * Where they come from depends on the channel:
 *
 * - Deterministic findings derive theirs mechanically, from the check that
 *   fired and the axes of the shot it fired on. No model, no cost, and exact:
 *   the criterion is the same check, stated as the passing state.
 * - Judged findings get theirs from the judge, which saw the defect and is the
 *   only thing that can say what its absence looks like. A finding filed before
 *   the judge emitted them falls back to its own `expected` prose, which is the
 *   same sentence written for a different purpose.
 * - Every issue also carries the guard the verdict rule already enforces
 *   silently: pixels have to have moved. Making it a criterion means the one
 *   rule that stops judge variance closing real defects is visible on the card
 *   rather than buried in a comment.
 *
 * Only lookout rules on them. There is no path by which a person ticks a box:
 * the verdicts are written by `verify-fix` and rendered read-only.
 */
import type { BacklogFinding } from "../backlog/lib.js";
import { shortHash } from "../util.js";

export type CriterionVerdict = "pending" | "met" | "unmet" | "not-verifiable";

export type CriterionSource = "derived" | "judge" | "universal";

export interface AcceptanceCriterion {
  /** Stable within the issue: derived from the source, origin and text. */
  id: string;
  text: string;
  source: CriterionSource;
  /**
   * Fingerprint of the finding this came from, when it came from one. A derived
   * criterion is ruled by re-running that finding's own check.
   */
  from?: string;
  verdict: CriterionVerdict;
  /** What the ruling saw. Present once it has been ruled at least once. */
  note?: string;
  /** When it was last ruled, and by which run. Absent means never ruled. */
  ruledAt?: string;
  runId?: string;
}

/** The one criterion every issue has, whatever channel found it. */
export const RECAPTURE_CRITERION =
  "Every screenshot this issue was filed against was re-captured, and at least one changed.";

/**
 * Keyed by what the criterion SAYS, not by which finding contributed it. Two
 * findings that would be proved fixed by the same observable claim are one
 * criterion: the card should not ask the same question twice because the same
 * defect was filed against two screenshots.
 */
function idOf(source: CriterionSource, text: string): string {
  return `c${shortHash(new TextEncoder().encode(`${source}|${text}`)).slice(0, 8)}`;
}

function criterion(
  source: CriterionSource,
  text: string,
  from?: string,
): AcceptanceCriterion {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return { id: idOf(source, trimmed), text: trimmed, source, ...(from ? { from } : {}), verdict: "pending" };
}

/** Where a criterion applies, said the way somebody re-photographing it would. */
function where(f: BacklogFinding): string {
  return `${f.route} at ${f.formFactor}, ${f.scheme} scheme`;
}

/**
 * The criterion a deterministic check states when it passes.
 *
 * Keyed off the attribute the check ingested under, so it stays in step with
 * DETERMINISTIC_MAP: an axe rule keeps its rule id, and everything else names
 * the failure it is the absence of.
 */
export function derivedCriterion(f: BacklogFinding): string {
  if (f.attribute.startsWith("axe-")) {
    return `No accessibility violation of rule \`${f.attribute.slice(4)}\` on ${where(f)}.`;
  }
  switch (f.attribute) {
    case "console-error":
      return `${f.route} loads with no console errors at ${f.formFactor}, ${f.scheme} scheme.`;
    case "page-error":
      return `${f.route} loads with no uncaught page errors at ${f.formFactor}, ${f.scheme} scheme.`;
    case "request-failed":
      return `Every request ${f.route} makes succeeds at ${f.formFactor}, ${f.scheme} scheme.`;
    case "horizontal-scroll":
      return `${f.route} does not scroll horizontally at ${f.formFactor}.`;
    case "blank":
      return `${f.route} renders visible content at ${f.formFactor}, ${f.scheme} scheme.`;
    case "capture-error":
      return `${f.route} can be captured at ${f.formFactor}, ${f.scheme} scheme.`;
    case "scheme-mechanism":
      return `${f.route} applies the ${f.scheme} scheme at ${f.formFactor}.`;
    case "stale-frame":
      return `${f.route} finishes rendering before it is captured at ${f.formFactor}.`;
    case "off-origin":
      return `${f.route} stays on the application's own origin at ${f.formFactor}.`;
    default:
      return `The ${f.category} defect "${f.title}" is gone on ${where(f)}.`;
  }
}

/** Everything one finding contributes, in the order it should be read. */
export function criteriaFor(f: BacklogFinding): AcceptanceCriterion[] {
  if (f.channel === "deterministic") {
    return [criterion("derived", derivedCriterion(f), f.fingerprint)];
  }
  const authored = (f.acceptance ?? []).map((t) => criterion("judge", t, f.fingerprint));
  if (authored.length > 0) return authored;

  // Filed before the judge wrote acceptance criteria, or by a judge that did
  // not. Its `expected` is the same sentence for a different purpose, so it
  // becomes the criterion rather than leaving the issue with nothing to test.
  const fallback = f.expected?.trim() || f.title.trim();
  return fallback ? [criterion("judge", `${fallback} (on ${where(f)})`, f.fingerprint)] : [];
}

/**
 * Compose an issue's list from its findings, keeping every verdict already
 * ruled. Criteria are matched by id, which is derived from their text, so
 * re-composing after a merge neither duplicates them nor forgets what lookout
 * has already decided about them.
 *
 * A criterion whose finding is gone is dropped: it describes a defect this
 * issue no longer has.
 */
export function composeAcceptance(
  members: BacklogFinding[],
  existing: AcceptanceCriterion[] = [],
): AcceptanceCriterion[] {
  const previous = new Map(existing.map((c) => [c.id, c]));
  const out: AcceptanceCriterion[] = [];
  const seen = new Set<string>();

  for (const member of members) {
    for (const fresh of criteriaFor(member)) {
      if (seen.has(fresh.id)) continue;
      seen.add(fresh.id);
      out.push(previous.get(fresh.id) ?? fresh);
    }
  }

  const universal = criterion("universal", RECAPTURE_CRITERION);
  if (!seen.has(universal.id)) out.push(previous.get(universal.id) ?? universal);
  return out;
}

/** A criterion ruled `unmet` blocks a pass; `not-verifiable` does not. */
export function blocksPass(criteria: AcceptanceCriterion[]): AcceptanceCriterion[] {
  return criteria.filter((c) => c.verdict === "unmet");
}

export function acceptanceTally(criteria: AcceptanceCriterion[]): {
  met: number;
  unmet: number;
  notVerifiable: number;
  pending: number;
  total: number;
} {
  const t = { met: 0, unmet: 0, notVerifiable: 0, pending: 0, total: criteria.length };
  for (const c of criteria) {
    if (c.verdict === "met") t.met++;
    else if (c.verdict === "unmet") t.unmet++;
    else if (c.verdict === "not-verifiable") t.notVerifiable++;
    else t.pending++;
  }
  return t;
}
