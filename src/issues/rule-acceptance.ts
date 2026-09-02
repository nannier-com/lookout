/**
 * Ruling an issue's acceptance criteria against freshly captured evidence.
 *
 * Only `verify-fix` calls this, and nothing else writes a verdict: the boxes on
 * the card are lookout's, and the UI has no endpoint that could change one.
 *
 * Each source is ruled by the thing that can actually decide it. A derived
 * criterion is the deterministic check restated, so the check itself rules it.
 * The universal one is the pixels-moved guard, which is a hash comparison. Only
 * the judge-authored ones need a model, and they get an independent pass over
 * the fresh screenshots rather than being inferred from whether the original
 * finding came back: two ways of being wrong are better than one way twice.
 */
import type { AcceptanceCriterion } from "./acceptance.js";

export interface DeterministicOutcome {
  /** Fingerprints of deterministic findings in the fresh evidence. */
  freshFingerprints: ReadonlySet<string>;
  /** Fingerprints whose shot was re-captured at all this run. */
  recapturedFingerprints: ReadonlySet<string>;
}

export interface JudgedCriterion {
  verdict: "pass" | "fail" | "not-verifiable";
  reasoning: string;
  /** The shots the verifier says decided it. */
  evidence?: string[];
  /** The verifier's one-line remedy, when it offered one. */
  suggestion?: string;
}

export interface RuleAcceptanceInput {
  criteria: AcceptanceCriterion[];
  changedShots: number;
  totalShots: number;
  /**
   * Shots in scope that had a previous hash to compare against. Zero means the
   * pixels-moved question cannot be asked at all (a cleaned evidence directory,
   * a route never captured before), which is `not-verifiable` rather than the
   * claim of sameness this used to make.
   */
  baselineShots: number;
  deterministic: DeterministicOutcome;
  /** Verdicts for the judge-authored criteria, by criterion id. */
  judged: Map<string, JudgedCriterion>;
  ruledAt: string;
  runId: string;
}

/** A new list with every criterion ruled; the input is not mutated. */
export function ruleAcceptance(input: RuleAcceptanceInput): AcceptanceCriterion[] {
  const stamp = { ruledAt: input.ruledAt, runId: input.runId };

  return input.criteria.map((c): AcceptanceCriterion => {
    if (c.source === "universal") {
      if (input.changedShots > 0) {
        return {
          ...c,
          ...stamp,
          verdict: "met",
          note: `${input.changedShots} of ${input.totalShots} screenshot(s) changed.`,
        };
      }
      // Nothing to compare against is not the same as nothing changed. Calling
      // the shots identical with no baseline would be a claim about pixels
      // lookout has never seen.
      if (input.baselineShots === 0) {
        return {
          ...c,
          ...stamp,
          verdict: "not-verifiable",
          note:
            `none of the ${input.totalShots} screenshot(s) in scope have a previous capture to ` +
            "compare against, so whether an edit reached the rendered output cannot be decided.",
        };
      }
      return {
        ...c,
        ...stamp,
        verdict: "unmet",
        note:
          `all ${input.baselineShots} comparable screenshot(s) are identical pixel for pixel ` +
          "to the previous run, so no edit reached the rendered output.",
      };
    }

    if (c.source === "derived") {
      const from = c.from ?? "";
      if (!input.deterministic.recapturedFingerprints.has(from)) {
        return {
          ...c,
          ...stamp,
          verdict: "not-verifiable",
          note: "the screenshot this was filed against was not re-captured in this run.",
        };
      }
      return input.deterministic.freshFingerprints.has(from)
        ? { ...c, ...stamp, verdict: "unmet", note: "the check still fires on the fresh capture." }
        : { ...c, ...stamp, verdict: "met", note: "the check no longer fires on the fresh capture." };
    }

    const judged = input.judged.get(c.id);
    // Never ruled is not the same as ruled and failing: a criterion the
    // verifier could not reach keeps whatever it had, and does not block.
    if (!judged) return c;
    return {
      ...c,
      ...stamp,
      verdict: judged.verdict === "pass" ? "met" : judged.verdict === "fail" ? "unmet" : "not-verifiable",
      note: judged.reasoning,
      // Which shots decided it and what the verifier would change: dropped
      // here for a long time, and exactly what a second attempt reads first.
      ...(judged.evidence && judged.evidence.length > 0 ? { evidence: judged.evidence } : {}),
      ...(judged.suggestion ? { suggestion: judged.suggestion } : {}),
    };
  });
}

/** The criteria a model has to look at, numbered the way the verifier numbers them. */
export function judgeableCriteria(criteria: AcceptanceCriterion[]): AcceptanceCriterion[] {
  return criteria.filter((c) => c.source === "judge");
}

export function asCriteriaText(criteria: AcceptanceCriterion[]): string {
  return criteria.map((c, i) => `${i + 1}. ${c.text}`).join("\n");
}

/**
 * Map the verifier's numbered results back onto the criteria they were made
 * about. The verifier re-extracts criteria from the text it is given, so the
 * numbering usually survives; when it does not, the text is matched instead,
 * and anything still unmatched is simply left unruled.
 */
export function matchJudged(
  criteria: AcceptanceCriterion[],
  results: { id: number; text: string; verdict: string; reasoning: string; evidence?: string[]; suggestion?: string }[],
): Map<string, JudgedCriterion> {
  const out = new Map<string, JudgedCriterion>();
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byText = new Map(criteria.map((c) => [normalise(c.text), c]));

  for (const r of results) {
    if (!["pass", "fail", "not-verifiable"].includes(r.verdict)) continue;
    const positional = criteria[r.id - 1];
    const target =
      positional && normalise(positional.text) === normalise(r.text)
        ? positional
        : byText.get(normalise(r.text)) ?? positional;
    if (!target || out.has(target.id)) continue;
    out.set(target.id, {
      verdict: r.verdict as JudgedCriterion["verdict"],
      reasoning: r.reasoning,
      ...(r.evidence && r.evidence.length > 0 ? { evidence: r.evidence.slice(0, 12) } : {}),
      ...(r.suggestion ? { suggestion: r.suggestion.slice(0, 300) } : {}),
    });
  }
  return out;
}
