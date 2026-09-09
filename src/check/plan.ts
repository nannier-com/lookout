/**
 * What to judge, and what has already been judged: one plan for one run.
 *
 * The two halves live apart. `loadJudging` (plan-load.ts) reads the skills,
 * the panels and the ledger once per run; `partitionGroups` (plan-partition.ts)
 * decides, for a set of shots, which (view group x panel) pairs still owe a
 * verdict. A plain check joins them here in one call; a screen walk loads
 * once and partitions each screen as it is captured.
 */
import type { PriorFinding } from "../judge/engine.js";
import type { Roster } from "../judge/dialogue.js";
import type { PanelRubric } from "../judge/rubric.js";
import type { Skill } from "../skills/load.js";
import type { Ledger, PanelIdentity } from "../judge/ledger.js";
import type { VerifiedFinding } from "../judge/verify.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import type { Parsed } from "../util.js";
import { loadJudging, type LoadedJudging } from "./plan-load.js";
import { partitionGroups, priorNames, type GroupPartition, type PanelWork } from "./plan-partition.js";

export type { PanelWork } from "./plan-partition.js";
export { rosterKeys, rosterOf } from "./plan-load.js";

export interface JudgePlan {
  /** The panels judging this run, after any --panels narrowing. */
  panels: PanelRubric[];
  refute: Skill;
  model: string;
  /**
   * The AIs judging this run, in the order they take their turn: the first
   * proposes and the second rules on what it filed.
   *
   * Absent, or holding one entry, is the single-AI pipeline exactly as it was,
   * which is what every project gets until it asks for a second judge.
   */
  roster?: Roster;
  /** The challenge instructions, loaded once, or absent when one AI judges. */
  challenge?: Skill;
  ledger: Ledger;
  /** One ledger identity per panel, keyed by panel name, computed once per run. */
  identities: Map<string, PanelIdentity>;
  /** The (view group x panel) pairs with no usable verdict on record. */
  toJudge: PanelWork[];
  /** The distinct shots those pairs cover, for logs and callbacks. */
  toJudgeShots: ShotRecord[];
  /**
   * Verdicts read back from the ledger. Their refutation state is whatever
   * was stored: a --no-verify run and the never-refuted band arrive with
   * verified false, and refute-on-read is the pass that repairs them.
   */
  cachedFindings: (VerifiedFinding & { cached: boolean })[];
  /** Shots whose every applicable in-scope panel was served from cache. */
  cached: number;
  /** What lookout already has open on these views, so one defect stays one issue. */
  prior: PriorFinding[];
  /**
   * What the project declared, for the refuter's own section: its never-file
   * lines (and, once declared, its design direction). The judges see the same
   * lines through the rubric's extensions slot; this is the refuter's copy.
   */
  declared?: string;
}

/** One run's loaded judging plus one partition, in the shape every judging step reads. */
export function asPlan(loaded: LoadedJudging, partition: GroupPartition, prior: PriorFinding[]): JudgePlan {
  return {
    panels: loaded.panels,
    refute: loaded.refute,
    model: loaded.model,
    roster: loaded.roster,
    ...(loaded.challenge ? { challenge: loaded.challenge } : {}),
    ledger: loaded.ledger,
    identities: loaded.identities,
    toJudge: partition.toJudge,
    toJudgeShots: partition.toJudgeShots,
    cachedFindings: partition.cachedFindings,
    cached: partition.cached,
    prior,
    ...(loaded.declared !== undefined ? { declared: loaded.declared } : {}),
  };
}

export async function planJudging(
  resolved: ResolvedConfig,
  shots: ShotRecord[],
  parsed: Parsed,
  /** Overridable so tests can exercise multi-panel partitions before the flip. */
  judges?: PanelRubric[],
): Promise<JudgePlan> {
  const loaded = await loadJudging(resolved, parsed, judges);
  const partition = partitionGroups(loaded, shots, { noCache: !!parsed.flags["no-cache"] });
  return asPlan(loaded, partition, await priorNames(resolved));
}
