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
import { groupShots, type PriorFinding } from "../judge/engine.js";
import { loadRubric, type Rubric } from "../judge/rubric.js";
import { loadSkill, type Skill } from "../skills/load.js";
import {
  groupHash,
  judgeIdentity,
  ledgerKey,
  loadLedger,
  type JudgeIdentity,
  type Ledger,
} from "../judge/ledger.js";
import type { VerifiedFinding } from "../judge/verify.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import { str, type Parsed } from "../util.js";

export interface JudgePlan {
  rubric: Rubric;
  refute: Skill;
  model: string;
  ledger: Ledger;
  /** Keys the ledger: which rules, which model, which version produced a verdict. */
  identity: JudgeIdentity;
  /** Shots with no usable verdict on record, which this run will judge. */
  toJudge: ShotRecord[];
  /**
   * Verdicts read back from the ledger. Their refutation state is whatever
   * was stored: a --no-verify run and the never-refuted band arrive with
   * verified false, and refute-on-read is the pass that repairs them.
   */
  cachedFindings: (VerifiedFinding & { cached: boolean })[];
  cached: number;
  /** What lookout already has open on these views, so one defect stays one issue. */
  prior: PriorFinding[];
}

export async function planJudging(
  resolved: ResolvedConfig,
  shots: ShotRecord[],
  parsed: Parsed,
): Promise<JudgePlan> {
  // 3. Skills + cache partition. Both AI passes are loaded once per run: a
  // skill amended mid-run would judge two batches by two different rules.
  const rubric = await loadRubric(resolved);
  const refute = await loadSkill(resolved, "refute-finding");
  const model = str(parsed.flags.model) ?? "sonnet";
  const ledger = await loadLedger(resolved);
  const toJudge: ShotRecord[] = [];
  const cachedFindings: (VerifiedFinding & { cached: boolean })[] = [];
  let cached = 0;
  // Cache by view group, not by single shot: a group re-judges whole whenever
  // any member's pixels moved, so a comparative finding never loses the shot
  // it compares against. Per-shot caching made a scoped re-check report a
  // dark/light or responsive finding as gone when only its partner had changed,
  // which is exactly the false "fixed" the auto loop must never see.
  const identity = judgeIdentity({
    version: rubric.version,
    rubricText: rubric.text,
    refuteText: refute.text,
    handoffText: rubric.handoff,
    model,
  });
  for (const group of groupShots(shots).values()) {
    // Hash identity decides, animated or not. Captures disable CSS animation,
    // so an animated view's stored still is usually byte-stable; when the
    // animation leaks into pixels anyway, the group hash misses on its own.
    // Vetoing the cache for animated groups re-judged byte-identical stills
    // forever (and wrote entries nothing could ever read); re-judging the
    // same bytes buys only judge variance. The flag's real job is context:
    // the judge prompt marks the shot as one frame of a moving view.
    const entry = ledger.entries[ledgerKey(groupHash(group), identity)];
    if (entry) {
      cached += group.length;
      for (const f of entry.findings ?? []) {
        // `verified` is read back, not asserted. A --no-verify run records
        // findings the refuter never saw, and medium and low findings are never
        // refuted at all, so stamping true here reported a check that had not
        // happened, in the one field that says how much to trust the finding.
        cachedFindings.push({ ...f, verified: f.verified ?? false, cached: true });
      }
    } else {
      toJudge.push(...group);
    }
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
    const b = await loadBacklog(resolved);
    const seen = new Set<string>();
    for (const f of Object.values(b.findings)) {
      if (f.status !== "open" || f.channel !== "ai") continue;
      for (const ev of f.evidence) {
        const key = `${ev.shotId}|${f.category}|${f.attribute}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prior.push({
          shotId: ev.shotId,
          category: f.category,
          attribute: f.attribute,
          title: f.title,
        });
      }
    }
  }

  return { rubric, refute, model, ledger, identity, toJudge, cachedFindings, cached, prior };
}
