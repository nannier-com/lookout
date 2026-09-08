/**
 * What to judge, and what has already been judged.
 *
 * Both AI passes are loaded once per run on purpose: a skill amended halfway
 * through would judge two batches by two different rules, and the ledger key
 * would then be lying about which rules produced which verdict.
 *
 * The partition is the interesting part. Caching is by VIEW GROUP rather than
 * by single shot, so a group re-judges whole whenever any member's pixels
 * moved: a comparative finding never loses the shot it compares against. Per
 * shot caching made a scoped re-check report a dark/light or responsive finding
 * as gone when only its partner had changed, which is exactly the false "fixed"
 * an automatic fix loop must never see.
 */
import { DEFAULT_JUDGE_MODEL, groupShots, isJudge, JUDGES, PRIMARY_AI, type PriorFinding } from "../judge/engine.js";
import type { Roster } from "../judge/dialogue.js";
import { loadJudges, type PanelRubric } from "../judge/rubric.js";
import { loadSkill, type Skill } from "../skills/load.js";
import {
  groupHash,
  ledgerKey,
  loadLedger,
  panelIdentity,
  type Ledger,
  type PanelIdentity,
} from "../judge/ledger.js";
import type { VerifiedFinding } from "../judge/verify.js";
import { declaredBlock, loadDirection } from "../judge/direction.js";
import { LookoutError, type ResolvedConfig, type ShotRecord } from "../types.js";
import { str, type Parsed } from "../util.js";

/** One judge call this run owes: one panel over one view group. */
export interface PanelWork {
  panel: PanelRubric;
  identity: PanelIdentity;
  groupId: string;
  shots: ShotRecord[];
}

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

/** The panels a view group should be judged by. */
function applicableOf(panels: PanelRubric[], group: ShotRecord[]): PanelRubric[] {
  return panels.filter((p) => !p.def.designOnly || group.some((s) => s.design));
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

export async function planJudging(
  resolved: ResolvedConfig,
  shots: ShotRecord[],
  parsed: Parsed,
  /** Overridable so tests can exercise multi-panel partitions before the flip. */
  judges?: PanelRubric[],
): Promise<JudgePlan> {
  // 3. Skills + cache partition. Every AI pass is loaded once per run: a
  // skill amended mid-run would judge two batches by two different rules.
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
  // its cached verdicts below, which is how a scoped verify-fix keeps the
  // other panels' standing findings visible while paying for one.
  const scoped = selectPanels(allPanels, str(parsed.flags.panels));
  const inScope = new Set(scoped.map((p) => p.def.name));

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
        ...(roster?.challenger ? { oracles: rosterKeys(roster), challengeText: challenge?.text ?? "" } : {}),
        ...(p.def.ariaEvidence ? { aria: true } : {}),
      }),
    ]),
  );

  const toJudge: PanelWork[] = [];
  const toJudgeShots: ShotRecord[] = [];
  const cachedFindings: (VerifiedFinding & { cached: boolean })[] = [];
  let cached = 0;
  // Cache by view group, not by single shot: a group re-judges whole whenever
  // any member's pixels moved, so a comparative finding never loses the shot
  // it compares against. Per-shot caching made a scoped re-check report a
  // dark/light or responsive finding as gone when only its partner had changed,
  // which is exactly the false "fixed" the auto loop must never see.
  for (const [groupId, group] of groupShots(shots)) {
    // Hash identity decides, animated or not. Captures disable CSS animation,
    // so an animated view's stored still is usually byte-stable; when the
    // animation leaks into pixels anyway, the group hash misses on its own.
    // Vetoing the cache for animated groups re-judged byte-identical stills
    // forever (and wrote entries nothing could ever read); re-judging the
    // same bytes buys only judge variance. The flag's real job is context:
    // the judge prompt marks the shot as one frame of a moving view.
    let allServed = true;
    for (const panel of applicableOf(allPanels, group)) {
      const identity = identities.get(panel.def.name)!;
      // Per panel, not per group: a panel shown the accessibility tree keys on
      // it, and one that is not keys exactly as it always did.
      const hash = groupHash(group, { aria: identity.aria });
      // --no-cache: serve nothing, still WRITE fresh verdicts. The model is in
      // the ledger key and a fresh verdict is the best entry there is, so a
      // forced re-judge repairs the cache rather than bypassing it. (The
      // conformance cache does the opposite under the same flag: its identity
      // gained a model term only recently, and old caches are discarded whole.)
      const entry = parsed.flags["no-cache"]
        ? undefined
        : ledger.entries[ledgerKey(hash, identity)];
      if (entry) {
        for (const f of entry.findings ?? []) {
          // `verified` is read back, not asserted. A --no-verify run records
          // findings the refuter never saw, and medium and low findings are never
          // refuted at all, so stamping true here reported a check that had not
          // happened, in the one field that says how much to trust the finding.
          cachedFindings.push({ ...f, verified: f.verified ?? false, cached: true });
        }
      } else if (inScope.has(panel.def.name)) {
        allServed = false;
        toJudge.push({ panel, identity, groupId, shots: group });
      }
      // A miss on a panel --panels excluded is out of scope: not judged, and
      // not counted unjudged, the same way a route outside --routes is not.
    }
    if (allServed) cached += group.length;
    else toJudgeShots.push(...group);
  }

  // What lookout already has open on these views. The judge writes the
  // `attribute` freehand, and it is half of both the fingerprint and the cluster
  // key, so the same defect returning under a different word mints a second
  // issue and splits the attempt history of the first. Showing it the name a
  // defect already carries is a few lines of prompt and keeps one defect one
  // issue. Only AI findings: the deterministic ones reach the judge as `signals`
  // on the shot, and it is told not to restate those.
  const prior: PriorFinding[] = [];
  if (resolved.configPath) {
    const { loadBacklog } = await import("../verbs/backlog.js");
    const { isShellRegion } = await import("../backlog/region.js");
    const b = await loadBacklog(resolved);
    const seen = new Set<string>();
    const ai = Object.values(b.findings).filter((f) => f.channel === "ai");
    const open = ai.filter((f) => f.status === "open");
    // Names a person has already settled travel too, and this is the case that
    // taught the lesson: once a colour-scheme defect was ruled by-design, the
    // next run no longer saw its name, re-filed it under a fresh attribute, and
    // minted a second issue that the ruling on the first could not reach. A
    // settled name is the most valuable one to reuse, because merge suppresses
    // an exact fingerprint and cannot suppress a synonym. Marked as settled so
    // the block never reads as a list of defects still standing.
    const settled = ai.filter(
      (f) => f.status === "by-design" || f.status === "blocked" || f.status === "fixed",
    );
    for (const f of [...open, ...settled]) {
      for (const ev of f.evidence) {
        const key = `${ev.shotId}|${f.category}|${f.attribute}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prior.push({
          shotId: ev.shotId,
          category: f.category,
          attribute: f.attribute,
          title: f.title,
          ...(f.status === "open" ? {} : { settled: true }),
        });
      }
    }
    // A shell finding is open everywhere at once, so its name travels to every
    // batch as a "*" entry. Until a project has any shell finding, every open
    // finding travels instead: the first regioned run is exactly when thirteen
    // independent calls would otherwise each invent a fresh attribute for one
    // chrome defect, and the aid exists to stop that. Capped worst-first so a
    // large backlog stays a naming aid rather than a second manifest.
    const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const shell = open.filter((f) => isShellRegion(f.region));
    // Open names first and worst-first, then settled ones: the cap is there to
    // keep this a naming aid rather than a second manifest, so what it drops
    // should be the least useful names, never the most urgent.
    const travelling = [
      ...(shell.length > 0 ? shell : open)
        .slice()
        .sort((a, b) => (RANK[a.severity] ?? 4) - (RANK[b.severity] ?? 4)),
      ...settled.filter((f) => shell.length === 0 || isShellRegion(f.region)),
    ].slice(0, 40);
    for (const f of travelling) {
      const key = `*|${f.category}|${f.attribute}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prior.push({
        shotId: "*",
        category: f.category,
        attribute: f.attribute,
        title: f.title,
        region: f.region,
        ...(f.status === "open" ? {} : { settled: true }),
      });
    }
  }

  return {
    panels: scoped,
    refute,
    model,
    roster,
    ...(challenge ? { challenge } : {}),
    ledger,
    identities,
    toJudge,
    toJudgeShots,
    cachedFindings,
    cached,
    prior,
    declared: declaredBlock(resolved.config.neverFile, await loadDirection(resolved)),
  };
}
