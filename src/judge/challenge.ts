/**
 * The second judge's turn: ruling on what the first one filed.
 *
 * lookout judged with one AI for its whole life, so every disagreement it could
 * have was with itself. Two AIs disagree differently, and the shape of this
 * module is entirely about making that disagreement usable rather than noisy.
 *
 * The decision everything else follows from: **the challenger answers by
 * index.** It is handed the findings numbered and rules `agree`, `dispute` or
 * `amend` on each, and it never restates a finding's category or attribute.
 * That is not a convenience. Those two fields are half of a finding's
 * fingerprint and half of the cluster key that mints its issue id, and they are
 * the only ones a model writes freehand: a challenger allowed to reword them
 * would turn one defect into two the moment it agreed in different words. By
 * answering positionally it cannot diverge on an identity it never writes.
 *
 * Only its ADDITIONS carry free text, because those are genuinely new defects
 * that have to be named by somebody. They go through the ordinary judge
 * ingestion with the same lane, so the category vocabulary, the severity
 * vocabulary, the shot ids and the out-of-lane rule all apply to them exactly
 * as they apply to a first judge's findings. Nothing here re-implements
 * validation that already exists.
 *
 * Nothing a model says here is trusted. A verdict word nobody recognises, an
 * index pointing at no finding, or a dispute with no account is a contract
 * failure, and each one is treated as ABSENT: the first judge's finding then
 * stands unchallenged. Never as a dispute. A mangled reply must not be able to
 * mark real defects contested.
 */
import { extractJson } from "./claude.js";
import { ingestJudgeReply, type PanelLane } from "./reply.js";
import type { AiFinding } from "./engine.js";
import type { ShotRecord } from "../types.js";
import type { Dissent, FindingConsensus, OracleId } from "../backlog/consensus.js";

/** One ruling on one of the first judge's findings. */
export interface ChallengeVerdict {
  index: number;
  verdict: "agree" | "dispute" | "amend";
  note?: string;
}

/** What a challenge round produced. */
export interface ChallengeReply {
  verdicts: ChallengeVerdict[];
  additions: AiFinding[];
  /** Rows the reply got wrong, for the incident log. */
  rejected: { reason: string; raw: unknown }[];
}

const VERDICTS = new Set(["agree", "dispute", "amend"]);
const MAX_NOTE = 300;

/**
 * The findings, numbered, as the challenger will address them.
 *
 * Category and attribute are shown because they are context a judge needs to
 * rule, and the skill tells it not to change them. Everything the challenger
 * sends back is keyed on the number in front.
 */
export function numberFindings(findings: readonly AiFinding[]): string {
  return findings
    .map((f, i) =>
      [
        `#${i} [${f.severity}] ${f.category}/${f.attribute} on ${f.shotId}`,
        `   ${f.title}`,
        `   problem: ${f.problem}`,
        `   expected: ${f.expected}`,
        `   observed: ${f.observed}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The challenger's reply, turned into rulings and new findings.
 *
 * `count` is how many findings were put to it, so an index outside that range
 * can be rejected rather than silently indexing into nothing.
 */
export function ingestChallenge(
  parsed: unknown,
  args: { count: number; shots: ShotRecord[]; project?: string; panel?: PanelLane },
): ChallengeReply {
  const rejected: { reason: string; raw: unknown }[] = [];
  const obj = (parsed ?? {}) as { verdicts?: unknown; additions?: unknown };
  const verdicts: ChallengeVerdict[] = [];
  const seen = new Set<number>();

  for (const raw of Array.isArray(obj.verdicts) ? obj.verdicts : []) {
    const r = (raw ?? {}) as { index?: unknown; verdict?: unknown; note?: unknown };
    const index = typeof r.index === "number" ? r.index : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= args.count) {
      rejected.push({ reason: `verdict for no such finding: ${String(r.index)}`, raw });
      continue;
    }
    if (seen.has(index)) {
      rejected.push({ reason: `two verdicts for finding #${index}`, raw });
      continue;
    }
    const verdict = String(r.verdict ?? "");
    if (!VERDICTS.has(verdict)) {
      rejected.push({ reason: `unknown verdict "${verdict}"`, raw });
      continue;
    }
    const note = typeof r.note === "string" ? r.note.trim().slice(0, MAX_NOTE) : "";
    // A dispute is the one answer that changes what a person sees, so it is the
    // one that has to be argued. Without a note it is not a dispute; the
    // finding stands rather than being quietly contested by an empty claim.
    if (verdict !== "agree" && !note) {
      rejected.push({ reason: `${verdict} for #${index} with no note`, raw });
      continue;
    }
    seen.add(index);
    verdicts.push({ index, verdict: verdict as ChallengeVerdict["verdict"], ...(note ? { note } : {}) });
  }

  // Additions are ordinary findings and are held to the ordinary contract: the
  // same categories, the same lane, the same shot ids, the same caps.
  const ingested = ingestJudgeReply(
    { findings: Array.isArray(obj.additions) ? obj.additions : [], cleanShotIds: [] },
    { shots: args.shots, project: args.project, panel: args.panel },
  );
  return { verdicts, additions: ingested.findings, rejected: [...rejected, ...ingested.rejected] };
}

/** The challenger's reply text, parsed, or the reason it was not usable. */
export function parseChallenge(
  text: string,
  args: { count: number; shots: ShotRecord[]; project?: string; panel?: PanelLane },
): ChallengeReply | null {
  try {
    return ingestChallenge(extractJson(text), args);
  } catch {
    return null;
  }
}

/**
 * What the two judges concluded about one finding.
 *
 * A finding nobody ruled on gets a consensus naming only its reporter, so the
 * record still says who filed it. Silence from a challenger is not agreement
 * and is not recorded as any.
 */
export function consensusFor(
  proposer: OracleId,
  challenger: OracleId,
  verdict: ChallengeVerdict | undefined,
  rounds: number,
): FindingConsensus {
  if (!verdict) return { reportedBy: proposer, rounds };
  if (verdict.verdict === "dispute") {
    const dissent: Dissent = { oracle: challenger, note: verdict.note ?? "" };
    return { reportedBy: proposer, disputedBy: [dissent], rounds };
  }
  // `amend` is agreement that the defect is real, with a caveat. The caveat is
  // kept as the challenger's own words rather than applied: the severity a
  // queue sorts by must not depend on which AI spoke last.
  return { reportedBy: proposer, agreedBy: [challenger], rounds };
}
