/**
 * What every judge call of one run shares: the skills, the panels, who
 * judges, the ledger, and each panel's ledger identity.
 *
 * Loaded once per run on purpose: a skill amended halfway through would judge
 * two batches by two different rules, and the ledger key would then be lying
 * about which rules produced which verdict. A screen walk loads this once and
 * partitions each screen against it (plan-partition.ts); a plain check does
 * both in one call (plan.ts).
 */
import { DEFAULT_JUDGE_MODEL, isJudge, JUDGES, PRIMARY_AI } from "../judge/engine.js";
import type { Roster } from "../judge/dialogue.js";
import { loadJudges, type PanelRubric } from "../judge/rubric.js";
import { loadSkill, type Skill } from "../skills/load.js";
import { loadLedger, panelIdentity, type Ledger, type PanelIdentity } from "../judge/ledger.js";
import { declaredBlock, loadDirection } from "../judge/direction.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { str, type Parsed } from "../util.js";

export interface LoadedJudging {
  /** Every panel, whether or not --panels narrowed the run: all of them serve cached verdicts. */
  allPanels: PanelRubric[];
  /** The panels judging this run, after any --panels narrowing. */
  panels: PanelRubric[];
  refute: Skill;
  model: string;
  /**
   * The AIs judging this run, in the order they take their turn: the first
   * proposes and the second rules on what it filed. One entry is the
   * single-AI pipeline, which is what every project gets until it asks for a
   * second judge.
   */
  roster: Roster;
  /** The challenge instructions, loaded once, or absent when one AI judges. */
  challenge?: Skill;
  ledger: Ledger;
  /** One ledger identity per panel, keyed by panel name, computed once per run. */
  identities: Map<string, PanelIdentity>;
  /**
   * What the project declared, for the refuter's own section: its never-file
   * lines (and, once declared, its design direction). The judges see the same
   * lines through the rubric's extensions slot; this is the refuter's copy.
   */
  declared?: string;
}

/**
 * Who judges, from the primary model and an optional `<ai>:<model>` challenger.
 *
 * Refused rather than ignored when the AI is not one lookout can judge with: a
 * flag somebody typed and lookout silently dropped is how a run comes to cost
 * one judge's money while its operator believes two were watching.
 */
export function rosterOf(model: string, challenger?: string): Roster {
  const proposer = { ai: PRIMARY_AI, model };
  if (!challenger) return { proposer };
  const at = challenger.indexOf(":");
  const ai = at === -1 ? challenger : challenger.slice(0, at);
  const its = at === -1 ? "" : challenger.slice(at + 1).trim();
  if (!isJudge(ai)) {
    throw new LookoutError(`no AI adapter for "${ai}"`, `lookout can judge with: ${JUDGES.join(", ")}`);
  }
  if (ai === proposer.ai) {
    throw new LookoutError(
      `${ai} cannot challenge itself`,
      "a second opinion from the same AI on the same evidence is the refuter, which already runs",
    );
  }
  if (!its) {
    throw new LookoutError(
      `--challenger ${ai} names no model`,
      `write it as --challenger ${ai}:<model>; lookout does not guess a model for an AI that publishes no stable alias`,
    );
  }
  return { proposer, challenger: { ai, model: its } };
}

/** The roster as the ledger hashes it. */
export function rosterKeys(roster: Roster): string[] {
  return [roster.proposer, ...(roster.challenger ? [roster.challenger] : [])].map((o) => `${o.ai}:${o.model}`);
}

/** The --panels flag, validated against the panels actually loaded. */
function selectPanels(panels: PanelRubric[], flag: string | undefined): PanelRubric[] {
  if (!flag) return panels;
  const known = new Map(panels.map((p) => [p.def.name, p]));
  return flag
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => {
      const p = known.get(name);
      if (!p) {
        throw new LookoutError(
          `unknown judge panel "${name}"`,
          `known: ${panels.map((x) => x.def.name).join(", ")}`,
        );
      }
      return p;
    });
}

export async function loadJudging(
  resolved: ResolvedConfig,
  parsed: Parsed,
  /** Overridable so tests can exercise multi-panel partitions before the flip. */
  judges?: PanelRubric[],
): Promise<LoadedJudging> {
  const refute = await loadSkill(resolved, "refute-finding");
  const model = str(parsed.flags.model) ?? DEFAULT_JUDGE_MODEL;
  // The second judge, when one was asked for. `--challenger codex:gpt-6-astra`
  // names the AI and the model in one word, because an AI without a model is
  // not something lookout can ask: only one of its CLIs publishes an alias that
  // survives a release, so a bare name would be a guess with a shelf life.
  const roster = rosterOf(model, str(parsed.flags.challenger));
  const challenge = roster.challenger ? await loadSkill(resolved, "judge-challenge") : undefined;
  const ledger = await loadLedger(resolved);
  const allPanels: PanelRubric[] = judges ?? (await loadJudges(resolved));
  // --panels narrows which panels JUDGE; every applicable panel still serves
  // its cached verdicts, which is how a scoped verify-fix keeps the other
  // panels' standing findings visible while paying for one.
  const panels = selectPanels(allPanels, str(parsed.flags.panels));

  const identities = new Map<string, PanelIdentity>(
    allPanels.map((p) => [
      p.def.name,
      panelIdentity({
        panel: p.def.name,
        version: p.version,
        panelText: p.text,
        refuteText: refute.text,
        handoffText: p.handoff,
        model,
        // What a verdict is worth depends on who reached it: a two-judge
        // verdict served to a one-judge run would be a stale verdict of the
        // most misleading kind.
        ...(roster.challenger ? { oracles: rosterKeys(roster), challengeText: challenge?.text ?? "" } : {}),
        ...(p.def.ariaEvidence ? { aria: true } : {}),
      }),
    ]),
  );

  return {
    allPanels,
    panels,
    refute,
    model,
    roster,
    ...(challenge ? { challenge } : {}),
    ledger,
    identities,
    declared: declaredBlock(resolved.config.neverFile, await loadDirection(resolved)),
  };
}
