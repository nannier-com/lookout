/**
 * Working out where each newly filed issue belongs, once.
 *
 * Placement is a property of the codebase, not of the run, so it is computed
 * when an issue is first filed and then kept. Re-deriving it on every backlog
 * save would re-ask a model the same question every time somebody adjudicated
 * an unrelated finding, and the answer would not have changed: marking one
 * issue by-design does not move a component into a different package.
 *
 * Issues that already carry a placement are skipped. So are projects with no
 * design system, where there is only one place a fix can go and asking would be
 * spending a model call to be told so.
 */
import { existsSync } from "node:fs";
import { placeDefect } from "./placement.js";
import { primaryKit, type DesignInventory, type DetectedKit } from "./inventory.js";
import { issuesOf } from "../issues/registry.js";
import { emit } from "../report/events.js";
import type { Backlog, IssuePlacement } from "../backlog/lib.js";
import type { ResolvedConfig } from "../types.js";

/**
 * The staleness recognition the stored `kit` field always promised.
 * Deterministic and free: a placement is re-derived (at model cost) only when
 * one of these says the codebase moved under it. Kit `exports` drift is
 * deliberately not a trigger, or every kit release would re-pay every
 * placement; and a kit that stops resolving entirely deletes nothing, because
 * detection can transiently fail and advice whose kit name is visibly absent
 * beats advice wiped by a flaky miss.
 */
export function placementStale(p: IssuePlacement, kit: DetectedKit): string | null {
  if (p.kit !== kit.name) return `it was reasoned against ${p.kit}; the project now uses ${kit.name}`;
  if (p.kitEditable !== kit.editable) return "the kit's editability changed since it was reasoned";
  if (p.primaryPath && !existsSync(p.primaryPath)) return `${p.primaryPath} no longer exists`;
  return null;
}

export interface PlacementRun {
  placed: number;
  /** Candidates beyond this run's cap; the next sweep takes them. */
  skipped: number;
  /** Calls that produced no placement: a miss is counted, never silent. */
  failed: number;
  /** The cap this run resolved, so the summary can say "off (cap 0)". */
  limit: number;
  costUsd: number;
}

/**
 * Fill in the placement for every open issue that lacks one. Mutates the
 * backlog in place; the caller saves.
 *
 * A failure to place one issue is not a failure of the run. Placement is
 * advice attached to a defect, and a defect with no advice is still a defect
 * worth reporting, so anything that goes wrong here is swallowed per issue and
 * the sweep continues.
 */
export async function placeNewIssues(
  resolved: ResolvedConfig,
  backlog: Backlog,
  inv: DesignInventory,
  opts: { model?: string; limit?: number } = {},
): Promise<PlacementRun> {
  const kit = primaryKit(inv);
  const limit = opts.limit ?? 12;
  if (!kit) return { placed: 0, skipped: 0, failed: 0, limit, costUsd: 0 };

  // Open issues only, and never the code channel. issuesOf defaults to every
  // status, which spent the cap on fixed and by-design issues nobody will
  // fix, starving the fresh ones; and a code finding's document already
  // renders "Where it is" with the exact path, line and symbol, so asking a
  // model where it belongs paid for an answer the record carried.
  //
  // Stale placements come FIRST: wrong advice sends a fix to the wrong file,
  // which is worse than no advice, so re-deriving it outranks placing a
  // fresh issue when the cap bites.
  const staleWhy = new Map<string, string>();
  const stale: ReturnType<typeof issuesOf> = [];
  const fresh: ReturnType<typeof issuesOf> = [];
  for (const c of issuesOf(backlog, { statuses: ["open"] })) {
    if (c.channel === "code") continue;
    const record = backlog.issues?.[c.id];
    if (!record) continue;
    if (!record.placement) {
      fresh.push(c);
    } else {
      const why = placementStale(record.placement, kit);
      if (why) {
        staleWhy.set(c.id, why);
        stale.push(c);
      }
    }
  }
  const open = [...stale, ...fresh];
  // A cap, because this costs a model call each and a first run on a neglected
  // project can file dozens. The rest get placed on the next sweep, and the
  // count is reported rather than silently dropped.
  const todo = open.slice(0, limit);
  let costUsd = 0;
  let placed = 0;
  let failed = 0;

  for (const cluster of todo) {
    const record = backlog.issues?.[cluster.id];
    if (!record) continue;
    const why = staleWhy.get(cluster.id);
    if (why) {
      emit("note", `re-deriving placement for ${cluster.id}: ${why}`, { issue: cluster.id, why });
    }
    try {
      const { placement: p, costUsd: callCost } = await placeDefect(resolved, cluster, inv, opts.model);
      costUsd += callCost;
      if (!p) {
        failed++;
        emit("note", `placement failed for ${cluster.id}; asked again next check`, { issue: cluster.id });
        continue;
      }
      record.placement = {
        kind: p.placement,
        primaryPath: p.primaryPath,
        symbol: p.symbol,
        reason: p.reason,
        otherCallers: p.otherCallers,
        blastRadius: p.blastRadius,
        alsoRead: p.alsoRead,
        notes: p.notes,
        kit: kit.name,
        kitEditable: kit.editable,
        at: new Date().toISOString(),
      };
      placed++;
      // Narration, not structure: the board is not reconstructed from placement,
      // so it rides the "note" kind rather than earning one of its own.
      emit(
        "note",
        `${cluster.id}: fix belongs ${p.placement}${p.primaryPath ? ` (${p.primaryPath})` : ""}`,
        { issue: cluster.id, placement: p.placement, path: p.primaryPath },
      );
    } catch (e) {
      // Advice, not evidence. Losing it costs the issue a section, and the
      // miss is counted so an all-fail sweep cannot report as a no-op.
      failed++;
      emit("note", `placement failed for ${cluster.id}: ${(e as Error).message.slice(0, 160)}`, {
        issue: cluster.id,
      });
      continue;
    }
  }

  return { placed, skipped: Math.max(0, open.length - todo.length), failed, limit, costUsd };
}
