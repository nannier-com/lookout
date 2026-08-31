/**
 * The per-member closure guard: which of a cluster's findings may not be
 * closed by this run, because nothing about their own evidence moved.
 *
 * The ledger's within-group promise ("a comparative finding never loses the
 * shot it compares against") stops at the view group, and a cluster can span
 * routes. In verify-fix that opened a gap: a fixer touches route A, route B's
 * unchanged views are served from cache (or re-judged clean by variance), and
 * the B member closes on a judgment about pixels that never moved. This
 * restores the promise end to end, as a theorem rather than a re-judge:
 * closure requires the member's own pixels to have moved since the finding
 * was last seen; moved pixels change the group hash; a changed group hash
 * forces a cache miss; so every closure is backed by a fresh judgment of the
 * member's complete view group, comparison partners included. The cache can
 * keep an issue open; it can never close one.
 *
 * AI members only. A deterministic member's oracle is a measurement, and a
 * measurement of unchanged pixels is trustworthy (the same argument the code
 * channel makes for source scans); exempting them also keeps legitimate
 * zero-pixel fixes (console errors, some a11y attributes) closable.
 *
 * The deliberate cost: a member genuinely fixed by an earlier, unrelated
 * commit whose pixels are now stable cannot be closed by a verify-fix pass.
 * It blocks at the attempt cap and needs a person, which is the miss this
 * design fails toward.
 */
import type { BacklogFinding } from "../backlog/lib.js";
import type { FixCluster } from "../fix/cluster.js";

/**
 * Members whose closure this run could not vouch for: AI-channel findings
 * none of whose own evidence shots changed since they were last seen.
 * `changedShots` is the set of shot ids whose fresh hash differs from the
 * baseline; a shot missing from the fresh capture changed nothing.
 */
export function unclosableMembers(
  cluster: FixCluster,
  changedShots: ReadonlySet<string>,
): BacklogFinding[] {
  return cluster.members.filter((m) => {
    if (m.channel !== "ai") return false;
    const own = new Set(m.evidence.map((e) => e.shotId));
    // A member with no evidence shots offers no way to show anything moved,
    // so nothing can vouch for closing it.
    for (const id of own) if (changedShots.has(id)) return false;
    return true;
  });
}
