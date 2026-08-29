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
import { placeDefect } from "./placement.js";
import { primaryKit, type DesignInventory } from "./inventory.js";
import { issuesOf } from "../issues/registry.js";
import { emit } from "../report/events.js";
import type { Backlog } from "../backlog/lib.js";
import type { ResolvedConfig } from "../types.js";

export interface PlacementRun {
  placed: number;
  skipped: number;
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
  if (!kit) return { placed: 0, skipped: 0, costUsd: 0 };

  const open = issuesOf(backlog).filter((c) => {
    const record = backlog.issues?.[c.id];
    return record && !record.placement;
  });
  // A cap, because this costs a model call each and a first run on a neglected
  // project can file dozens. The rest get placed on the next sweep, and the
  // count is reported rather than silently dropped.
  const limit = opts.limit ?? 12;
  const todo = open.slice(0, limit);
  let costUsd = 0;
  let placed = 0;

  for (const cluster of todo) {
    const record = backlog.issues?.[cluster.id];
    if (!record) continue;
    try {
      const p = await placeDefect(resolved, cluster, inv, opts.model);
      if (!p) continue;
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
      costUsd += p.costUsd ?? 0;
      placed++;
      // Narration, not structure: the board is not reconstructed from placement,
      // so it rides the "note" kind rather than earning one of its own.
      emit(
        "note",
        `${cluster.id}: fix belongs ${p.placement}${p.primaryPath ? ` (${p.primaryPath})` : ""}`,
        { issue: cluster.id, placement: p.placement, path: p.primaryPath },
      );
    } catch {
      // Advice, not evidence. Losing it costs the issue a section.
      continue;
    }
  }

  return { placed, skipped: Math.max(0, open.length - todo.length), costUsd };
}
