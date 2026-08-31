/**
 * View groups, and the batches they are judged in.
 *
 * A view group is one route and state across its form factors and colour
 * schemes, and it is the unit almost everything here counts in: the rubric
 * compares within it, the ledger caches by it, and a batch is one of them.
 * Making the batch any larger buys nothing the judge can use and holds every
 * finding in it hostage until the whole batch returns, which on full-page
 * screenshots ran to several silent minutes.
 */
import type { ShotRecord } from "../types.js";

export function kebab(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

/** Pack shots into judge batches: same target+route stays together, max size. */
/** The view a shot belongs to: everything the rubric compares across. */
export function viewGroupId(shot: ShotRecord): string {
  return `${shot.target}|${shot.platform}|${shot.route}|${shot.state}`;
}

/** Partition shots into view groups, preserving encounter order. */
export function groupShots(shots: ShotRecord[]): Map<string, ShotRecord[]> {
  const groups = new Map<string, ShotRecord[]>();
  for (const s of shots) {
    const id = viewGroupId(s);
    const arr = groups.get(id) ?? [];
    arr.push(s);
    groups.set(id, arr);
  }
  return groups;
}

/**
 * One judge call per VIEW GROUP: the same unit the rubric compares within, and
 * the same unit the ledger caches.
 *
 * This used to pack several small groups into one call to save subprocesses,
 * which quietly broke the cache. The rubric asks for one finding per distinct
 * defect, filed on the most representative shot, with the other affected shots
 * named in the prose. When two groups shared a batch and shared a defect, the
 * judge filed it against one of them and the contract then put the other
 * group's shots in `cleanShotIds`, so that view was recorded clean and a later
 * scoped re-check served "clean" from cache while the defect stood. Keeping the
 * prompt unit and the ledger unit identical is what makes a cached verdict mean
 * anything.
 *
 * A group is never split either: a comparison needs both sides in one context.
 */
export function batchShots(shots: ShotRecord[]): ShotRecord[][] {
  return [...groupShots(shots).values()];
}
