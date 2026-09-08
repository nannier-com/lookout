/**
 * Two judges reaching one account of what is wrong.
 *
 * One AI proposes, a second challenges what it filed, and what comes out is a
 * single set of findings each carrying who agreed and who did not. The order
 * matters and is not symmetric: the proposer names each defect, and the
 * challenger rules on those names rather than inventing its own, which is what
 * keeps one defect one row in the backlog.
 *
 * The fan-out lives HERE and not inside `judgeBatch`, deliberately. A dialogue
 * has to be a property of the call, because one caller must never inherit it:
 * `skills replay` grades an amendment by re-judging a frozen set of
 * screenshots, and the gate is already fighting the variance of one model
 * answering differently twice. Adding a second model's variance to that would
 * make the gate reject good amendments. Replay calls `judgeBatch` directly, so
 * it opts out by construction rather than by remembering to pass a flag.
 *
 * What a disagreement does, and does not, do:
 *
 *   it is kept    a disputed finding is still filed and still open. Nothing an
 *                 AI saw is discarded because another disagreed; both accounts
 *                 are recorded and a person reads them.
 *   it is not a   a dispute changes no status and no severity. Letting one AI
 *   verdict       close or downgrade another's finding would hand a single
 *                 vendor a veto over the backlog.
 *   it is bounded one challenge round, and a second only when the challenger
 *                 added findings of its own for the proposer to rule on. There
 *                 is no convergence loop: residual disagreement is the OUTPUT,
 *                 not a failure to retry away.
 *
 * A challenge that fails is not fatal and not silent. The proposal stands
 * alone, the batch is reported as undialogued so the caller can decline to
 * cache it, and the reason is recorded. Caching a verdict as though two judges
 * had agreed when only one ever spoke is the one outcome worth avoiding.
 */
import { judgeBatch, type AiFinding, type JudgeBatchResult, type JudgeContext } from "./engine.js";
import { consensusFor, numberFindings, parseChallenge, type ChallengeVerdict } from "./challenge.js";
import { invokeAi } from "./adapters.js";
import { renderSkill } from "../skills/load.js";
import { readingInstructionFor } from "./adapters.js";
import { manifestOf } from "./manifest.js";
import { closeCall, narrating, openCall, say } from "../report/narration.js";
import type { ShotRecord } from "../types.js";

/** The AIs in a dialogue, and what each judges with. */
export interface Roster {
  proposer: { ai: string; model: string };
  /** Absent when only one AI is configured, which is the single-judge pipeline. */
  challenger?: { ai: string; model: string };
}

/** One dialogue's outcome: a batch result, plus what the second judge did. */
export interface DialogueResult extends JudgeBatchResult {
  /**
   * False when a challenger was configured and could not be reached or could
   * not be understood. The caller leaves such a batch out of the cache: the
   * verdict is one judge's, and a cache entry keyed to a two-judge identity
   * would durably record a dialogue that never happened.
   */
  dialogued: boolean;
  /** Why there was no dialogue, when one was expected. */
  undialoguedReason?: string;
}

/** How many extra rounds a disagreement is worth. */
const MAX_ROUNDS = 2;

/**
 * Judge a batch with one AI, then have the other rule on what it filed.
 *
 * With no challenger this is `judgeBatch` and nothing else, which is what every
 * existing project gets until it configures a second AI.
 */
export async function judgeWithDialogue(
  skillText: string,
  project: string,
  shots: ShotRecord[],
  evidenceDir: string,
  roster: Roster,
  ctx: JudgeContext & { challengeSkill?: string } = {},
): Promise<DialogueResult> {
  const first = await judgeBatch(skillText, project, shots, evidenceDir, roster.proposer.model, {
    ...ctx,
    ai: roster.proposer.ai,
  });
  const stamped = first.findings.map((f) => ({ ...f, oracle: roster.proposer.ai }));
  if (!roster.challenger || !ctx.challengeSkill || stamped.length === 0) {
    // Nothing to argue about is not a failed dialogue. A batch where the
    // proposer found nothing has no findings to rule on, and asking a second
    // AI to confirm an empty list buys nothing.
    return { ...first, findings: stamped, dialogued: true };
  }

  const challenger = roster.challenger;
  let reply;
  try {
    const prompt = renderSkill(ctx.challengeSkill, {
      manifest: manifestOf(shots, evidenceDir, ctx.pieces),
      lane: (ctx.panel?.categories ?? []).join(", "),
      findings: numberFindings(stamped),
      howToOpen: readingInstructionFor(challenger.ai),
    });
    // Its own voice, naming the AI as well as the panel. Two judges speaking
    // inside one panel's turn would otherwise interleave under one heading, and
    // a transcript that cannot say which of them said a thing is no use for the
    // one question a dialogue exists to answer.
    const voice = `${ctx.panel?.name ?? "judge"} \u00b7 ${challenger.ai}`;
    const call = openCall(voice, `challenging ${stamped.length} finding(s)`);
    let said;
    try {
      said = await invokeAi(challenger.ai, {
        prompt,
        model: challenger.model,
        capabilities: ["read-files"],
        onSay: narrating() ? (t) => say(call, voice, t) : undefined,
      });
    } finally {
      closeCall(call, voice);
    }
    reply = parseChallenge(said.text, {
      count: stamped.length,
      shots,
      project: ctx.projectDir,
      panel: ctx.panel,
    });
  } catch (e) {
    return { ...first, findings: stamped, dialogued: false, undialoguedReason: (e as Error).message };
  }
  if (!reply) {
    return {
      ...first,
      findings: stamped,
      dialogued: false,
      undialoguedReason: "the second judge's reply could not be read",
    };
  }

  const byIndex = new Map<number, ChallengeVerdict>(reply.verdicts.map((v) => [v.index, v]));
  const ruled: AiFinding[] = stamped.map((f, i) => ({
    ...f,
    consensus: consensusFor(roster.proposer.ai, challenger.ai, byIndex.get(i), 1),
  }));
  // The challenger's own findings. They arrive unruled: the proposer has not
  // seen them, so nothing may claim it agreed. A second round would put them
  // to it, and until there is one they stand as this AI's sole account.
  const added: AiFinding[] = reply.additions.map((f) => ({
    ...f,
    oracle: challenger.ai,
    consensus: { reportedBy: challenger.ai, rounds: MAX_ROUNDS - 1 },
  }));
  return {
    ...first,
    findings: [...ruled, ...added],
    rejected: [...first.rejected, ...reply.rejected],
    dialogued: true,
  };
}
