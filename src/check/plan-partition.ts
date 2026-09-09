/**
 * Which (view group x panel) pairs still need a verdict, and what the backlog
 * already calls the defects on these views.
 *
 * Caching is by VIEW GROUP rather than by single shot, so a group re-judges
 * whole whenever any member's pixels moved: a comparative finding never loses
 * the shot it compares against. Per shot caching made a scoped re-check report
 * a dark/light or responsive finding as gone when only its partner had changed,
 * which is exactly the false "fixed" an automatic fix loop must never see.
 */
import { groupShots, type PriorFinding } from "../judge/engine.js";
import type { PanelRubric } from "../judge/rubric.js";
import { groupHash, ledgerKey, type PanelIdentity } from "../judge/ledger.js";
import type { VerifiedFinding } from "../judge/verify.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import type { LoadedJudging } from "./plan-load.js";

/** One judge call this run owes: one panel over one view group. */
export interface PanelWork {
  panel: PanelRubric;
  identity: PanelIdentity;
  groupId: string;
  shots: ShotRecord[];
}

export interface GroupPartition {
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
}

/** The panels a view group should be judged by. */
function applicableOf(panels: PanelRubric[], group: ShotRecord[]): PanelRubric[] {
  return panels.filter((p) => !p.def.designOnly || group.some((s) => s.design));
}

export function partitionGroups(
  loaded: LoadedJudging,
  shots: ShotRecord[],
  opts: { noCache: boolean },
): GroupPartition {
  const inScope = new Set(loaded.panels.map((p) => p.def.name));
  const toJudge: PanelWork[] = [];
  const toJudgeShots: ShotRecord[] = [];
  const cachedFindings: (VerifiedFinding & { cached: boolean })[] = [];
  let cached = 0;
  for (const [groupId, group] of groupShots(shots)) {
    // Hash identity decides, animated or not. Captures disable CSS animation,
    // so an animated view's stored still is usually byte-stable; when the
    // animation leaks into pixels anyway, the group hash misses on its own.
    // Vetoing the cache for animated groups re-judged byte-identical stills
    // forever (and wrote entries nothing could ever read); re-judging the
    // same bytes buys only judge variance. The flag's real job is context:
    // the judge prompt marks the shot as one frame of a moving view.
    let allServed = true;
    for (const panel of applicableOf(loaded.allPanels, group)) {
      const identity = loaded.identities.get(panel.def.name)!;
      // Per panel, not per group: a panel shown the accessibility tree keys on
      // it, and one that is not keys exactly as it always did.
      const hash = groupHash(group, { aria: identity.aria });
      // --no-cache: serve nothing, still WRITE fresh verdicts. The model is in
      // the ledger key and a fresh verdict is the best entry there is, so a
      // forced re-judge repairs the cache rather than bypassing it. (The
      // conformance cache does the opposite under the same flag: its identity
      // gained a model term only recently, and old caches are discarded whole.)
      const entry = opts.noCache ? undefined : loaded.ledger.entries[ledgerKey(hash, identity)];
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
  return { toJudge, toJudgeShots, cachedFindings, cached };
}

/**
 * What lookout already has open on these views. The judge writes the
 * `attribute` freehand, and it is half of both the fingerprint and the cluster
 * key, so the same defect returning under a different word mints a second
 * issue and splits the attempt history of the first. Showing it the name a
 * defect already carries is a few lines of prompt and keeps one defect one
 * issue. Only AI findings: the deterministic ones reach the judge as `signals`
 * on the shot, and it is told not to restate those.
 */
export async function priorNames(resolved: ResolvedConfig): Promise<PriorFinding[]> {
  const prior: PriorFinding[] = [];
  if (!resolved.configPath) return prior;
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
  return prior;
}
