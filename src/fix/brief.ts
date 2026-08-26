/**
 * Naming an issue.
 *
 * lookout finds issues and documents them. It used to also render each one as
 * an executable prompt and tell a session to spawn a subagent on it; that is no
 * longer its job, and the brief went with it. What remains is the one thing the
 * backlog and the UI both need: a short human name for a root cause.
 */
import type { FixCluster } from "./cluster.js";

/** Short name for one issue: what is wrong, and where. */
export function clusterLabel(c: FixCluster): string {
  const what = c.defects.length > 1 ? `${c.category} (${c.defects.length} rules)` : `${c.category}/${c.attribute}`;
  const where = c.routes.length > 2 ? `${c.routes.length} routes` : c.routes.join(" ");
  return `${what} on ${where}`;
}
