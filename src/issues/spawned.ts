/**
 * Issues a fix surfaced somewhere else.
 *
 * A fix that clears its own defect and causes a different one is not that
 * issue regressing. It is a new defect, and lookout files new defects the way
 * it files every other one: its own number, its own folder, its own evidence.
 * What this adds is the provenance, which the merge cannot know: which fix was
 * in flight when the defect first appeared.
 *
 * Kept pure and apart from the verb so the rule can be argued with in a test.
 * The rule that matters: a finding on a screenshot whose pixels did not move
 * cannot have been caused by anything that ran. It still becomes an issue; it
 * just is not attributed to the fix, because attributing it would be a guess
 * dressed as a record.
 */
import type { Backlog } from "../backlog/lib.js";
import type { FixCluster } from "../fix/cluster.js";
import { issuesOf } from "./registry.js";

export interface SpawnedIssue {
  issue: FixCluster;
  /** True when its evidence sits on a screenshot this run actually changed. */
  causedByThisFix: boolean;
}

/** Issues present after this run that were not present before it. */
export function spawnedIssues(
  before: Backlog,
  after: Backlog,
  changedShotIds: ReadonlySet<string>,
  excludeIssueId?: string,
): SpawnedIssue[] {
  return issuesOf(after)
    .filter((c) => !before.issues?.[c.id] && c.id !== excludeIssueId)
    .map((issue) => ({
      issue,
      causedByThisFix: issue.members.some((m) =>
        m.evidence.some((e) => changedShotIds.has(e.shotId)),
      ),
    }));
}

/**
 * Record where a spawned issue came from. Only the ones on changed pixels, and
 * only once: the first fix that surfaced a defect is the one that surfaced it,
 * and a later re-check must not rewrite that.
 */
export function stampCausedBy(
  after: Backlog,
  spawned: SpawnedIssue[],
  by: { issue: string; commit: string | null; runId: string; at: string },
): string[] {
  const stamped: string[] = [];
  for (const s of spawned) {
    if (!s.causedByThisFix) continue;
    const record = after.issues?.[s.issue.id];
    if (!record || record.causedBy) continue;
    record.causedBy = by;
    stamped.push(record.id);
  }
  return stamped;
}
