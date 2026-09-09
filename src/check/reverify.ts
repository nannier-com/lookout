/**
 * Refute-on-read: repair cached verdicts whose findings the refuter never saw.
 *
 * There were two ways for a finding to reach the ledger unrefuted, and they
 * used to get opposite cache treatment. A refuter subprocess failure left the
 * group out of the cache "so a later run can still refute them"; a
 * `--no-verify` run cached the group, so every later run served the findings
 * verbatim and the refuter was durably skipped for the life of those pixels.
 * Both now cache, and this pass is the single road back: any cached group
 * holding findings with `verified: false` gets the adversarial pass against
 * the shots just captured, and the entry is repaired in place.
 *
 * Self-extinguishing by design: each entry is repaired at most once, clean
 * groups have nothing to refute and cost nothing, and the per-run cap keeps
 * the bill bounded on a project with a long unrefuted backlog. A repair that
 * fails leaves the entry exactly as it was, so the next run tries again;
 * silence is never cached as checked.
 */
import { evidenceDir } from "../config.js";
import { groupShots, type AiFinding } from "../judge/engine.js";
import { groupHash, ledgerKey } from "../judge/ledger.js";
import type { PanelRubric } from "../judge/rubric.js";
import { verifyFindings } from "../judge/verify.js";
import { emit } from "../report/events.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import type { Parsed } from "../util.js";
import { workKey } from "./batches.js";
import type { JudgePlan } from "./plan.js";

/** Cap per run: repairs are a tax on old debt, not the run's main job. */
export const MAX_REVERIFY_GROUPS = 8;

export interface ReverifyResult {
  /** Groups whose entries were repaired this run. */
  repaired: number;
  /** Groups that held unrefuted findings but were beyond the cap. */
  deferred: number;
  refuted: (AiFinding & { verifierNote: string })[];
  costUsd: number;
}

/**
 * Repair up to MAX_REVERIFY_GROUPS cached entries, mutating `plan.ledger`
 * (persisted by recordOutcome's save) and `plan.cachedFindings` (consumed by
 * the outcome) in place.
 */
export async function reverifyCached(args: {
  resolved: ResolvedConfig;
  plan: JudgePlan;
  shotsById: Map<string, ShotRecord>;
  parsed: Parsed;
  log: (line: string) => void;
  /**
   * How many entries this call may repair; MAX_REVERIFY_GROUPS unless the
   * caller is spreading one run's cap over several calls, as a screen walk
   * does, so that sixty screens cannot buy sixty times the debt service.
   */
  limit?: number;
}): Promise<ReverifyResult> {
  const { resolved, plan, shotsById, parsed, log } = args;
  const none: ReverifyResult = { repaired: 0, deferred: 0, refuted: [], costUsd: 0 };
  // The same off switch as the inline pass: --no-verify means "no adversarial
  // spend this run", and the debt simply waits.
  if (parsed.flags["no-verify"]) return none;

  // Candidates are (group, panel) LEDGER ENTRIES, not groups: with per-panel
  // caching a group can be half fresh work and half cached debt, and repairs
  // are debt service on whatever entry holds unverified findings and is not
  // being re-judged this run anyway.
  const inWork = new Set(plan.toJudge.map((item) => workKey(item)));
  const candidates: { key: string; shots: ShotRecord[]; panel: PanelRubric }[] = [];
  for (const [groupId, group] of groupShots([...shotsById.values()])) {
    for (const panel of plan.panels) {
      if (panel.def.designOnly && !group.some((s) => s.design)) continue;
      if (inWork.has(`${groupId}|${panel.def.name}`)) continue;
      const identity = plan.identities.get(panel.def.name)!;
      const key = ledgerKey(groupHash(group, { aria: identity.aria }), identity);
      const entry = plan.ledger.entries[key];
      if (entry?.findings?.some((f) => !f.verified)) candidates.push({ key, shots: group, panel });
    }
  }
  if (candidates.length === 0) return none;

  const todo = candidates.slice(0, Math.max(0, args.limit ?? MAX_REVERIFY_GROUPS));
  if (todo.length === 0) return { ...none, deferred: candidates.length };
  const result: ReverifyResult = {
    repaired: 0,
    deferred: candidates.length - todo.length,
    refuted: [],
    costUsd: 0,
  };
  const evDir = evidenceDir(resolved);
  log(
    `refuting ${todo.length} cached group(s) whose findings the refuter never saw` +
      (result.deferred > 0 ? ` (${result.deferred} more wait for the next run)` : ""),
  );

  for (const { key, shots, panel } of todo) {
    const entry = plan.ledger.entries[key]!;
    const kept = entry.findings!.filter((f) => f.verified);
    const unverified = entry.findings!.filter((f) => !f.verified);
    try {
      const groupMap = new Map(shots.map((s) => [s.id, s]));
      const v = await verifyFindings(plan.refute.text, unverified, groupMap, evDir, plan.model, resolved.projectDir, plan.declared ?? "");
      result.costUsd += v.costUsd ?? 0;
      result.refuted.push(...v.refuted);
      const findings = [...kept, ...v.confirmed];
      if (findings.length > 0) {
        entry.verdict = "findings";
        entry.findings = findings;
      } else {
        entry.verdict = "clean";
        delete entry.findings;
      }
      // The outcome serves cached findings from plan.cachedFindings, so the
      // repair has to land there too or the run would report what the ledger
      // no longer says. Filtered by shot AND lane: the sibling panels' cached
      // findings for the same shots were not re-refuted and must stand.
      const ids = new Set(shots.map((s) => s.id));
      const owned = new Set(panel.def.categories as readonly string[]);
      const rest = plan.cachedFindings.filter(
        (f) => !(ids.has(f.shotId) && owned.has(f.category)),
      );
      plan.cachedFindings.length = 0;
      plan.cachedFindings.push(...rest, ...findings.map((f) => ({ ...f, cached: true })));
      result.repaired++;
    } catch (e) {
      // The entry stands untouched: unverified is a true account, and the next
      // run gets the same chance this one had.
      const message = e instanceof Error ? e.message : String(e);
      log(`  refute-on-read failed for one group: ${message}`);
      emit("note", `refute-on-read failed for one group: ${message}`, { key });
    }
  }
  if (result.refuted.length > 0) {
    log(`refute-on-read killed ${result.refuted.length} cached finding(s)`);
  }
  return result;
}
