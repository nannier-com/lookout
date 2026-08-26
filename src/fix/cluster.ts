/**
 * Root-cause clustering.
 *
 * The judge files one finding per shot, so a single code cause shows up N
 * times: a theme that never switches produces a colour-scheme finding on every
 * light shot of every route. Dispatching those as N pieces of work would have N
 * sessions race each other to the same edit.
 *
 * A cluster is one target + category + attribute. That is the unit of work a
 * fix session is given, and the unit `verify-fix` rules on. Its id is derived
 * from the key alone, so it stays the same across attempts and runs for as long
 * as the defect exists.
 */
import type { BacklogFinding, FindingStatus } from "../backlog/lib.js";
import { routeSlug } from "../capture/store.js";
import type { Severity } from "../types.js";
import type { Category } from "../judge/rubric.js";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface FixCluster {
  /** Stable handle: the `--cluster` argument and the brief's filename. */
  id: string;
  target: string;
  category: Category;
  attribute: string;
  /** Every distinct defect in the cluster, worst first; one entry per attribute. */
  defects: { attribute: string; severity: Severity; title: string; problem: string }[];
  /** Worst severity among the members. */
  severity: Severity;
  /** Representative title, taken from the worst member. */
  title: string;
  problem: string;
  expected: string;
  observed: string;
  routes: string[];
  fingerprints: string[];
  members: BacklogFinding[];
  /** Distinct screenshots the cluster appears on. */
  shotCount: number;
  /** Findings in the cluster; higher than shotCount when rules share a shot. */
  findingCount: number;
  /** Attempts already spent on this cluster (max across members). */
  attemptsSpent: number;
  /** True when the adversarial verifier confirmed at least one member. */
  verified: boolean;
  channel: BacklogFinding["channel"];
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function clusterIdOf(
  f: Pick<BacklogFinding, "target" | "category" | "attribute" | "channel" | "route">,
): string {
  // Deterministic accessibility findings are keyed by axe rule id, which names
  // the rule that fired rather than the thing that is wrong. One malformed
  // composite widget trips three or four rules at once, so keying on the rule
  // would aim that many fix sessions at a single component and have them
  // collide in the same files. Co-located a11y violations share a cause far
  // more often than one rule spans routes, so group them by route instead.
  if (f.channel === "deterministic" && f.category === "a11y") {
    return `${slug(f.target)}--${slug(routeSlug(f.route))}--a11y`;
  }
  return `${slug(f.target)}--${slug(f.category)}--${slug(f.attribute)}`;
}

export interface ClusterOptions {
  /** Worst-acceptable severity to include; defaults to every severity. */
  minSeverity?: Severity;
  /** Statuses to draw from; defaults to open only. */
  statuses?: FindingStatus[];
  /** Clusters at or past this many attempts are left out (they are blocked). */
  maxAttempts?: number;
  /** Restrict to these targets. */
  targets?: string[];
}

/**
 * Group a backlog's findings into dispatchable clusters, worst first, and
 * within a severity the broadest blast radius first: fixing the thing that
 * affects the most shots is the fastest way to shrink the backlog.
 */
export function clusterFindings(
  findings: BacklogFinding[],
  opts: ClusterOptions = {},
): FixCluster[] {
  const statuses = opts.statuses ?? (["open"] as FindingStatus[]);
  const cap = opts.minSeverity ? SEVERITY_RANK[opts.minSeverity] : SEVERITY_RANK.low;
  const byId = new Map<string, BacklogFinding[]>();

  for (const f of findings) {
    if (!statuses.includes(f.status)) continue;
    if (SEVERITY_RANK[f.severity] > cap) continue;
    if (opts.targets && !opts.targets.includes(f.target)) continue;
    const id = clusterIdOf(f);
    const arr = byId.get(id) ?? [];
    arr.push(f);
    byId.set(id, arr);
  }

  const clusters: FixCluster[] = [];
  for (const [id, members] of byId) {
    const sorted = [...members].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    const worst = sorted[0]!;
    const attemptsSpent = Math.max(...members.map((m) => m.fixAttempts));
    if (opts.maxAttempts !== undefined && attemptsSpent >= opts.maxAttempts) continue;
    const defects: FixCluster["defects"] = [];
    for (const m of sorted) {
      if (defects.some((d) => d.attribute === m.attribute)) continue;
      defects.push({ attribute: m.attribute, severity: m.severity, title: m.title, problem: m.problem });
    }
    const shotIds = new Set(
      members
        .map((m) => m.evidence[m.evidence.length - 1]?.shotId)
        .filter((v): v is string => v !== undefined),
    );
    const routes = [...new Set(members.map((m) => m.route))].sort();
    clusters.push({
      id,
      target: worst.target,
      category: worst.category,
      attribute: worst.attribute,
      defects,
      severity: worst.severity,
      // A grouped cluster's headline names the group; the worst member's title
      // would advertise one of several defects and mislead the fix session.
      title:
        defects.length > 1
          ? `${defects.length} ${worst.category} defects on ${routes.join(", ")}`
          : worst.title,
      problem: worst.problem,
      expected: worst.expected,
      observed: worst.observed,
      routes,
      fingerprints: members.map((m) => m.fingerprint).sort(),
      members: sorted,
      shotCount: shotIds.size || members.length,
      findingCount: members.length,
      attemptsSpent,
      verified: members.some((m) => m.verified),
      channel: worst.channel,
    });
  }

  return clusters.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.shotCount - a.shotCount ||
      a.id.localeCompare(b.id),
  );
}

/** The capture scope that covers a cluster, for a scoped re-check. */
export function clusterScope(c: FixCluster): { targets: string[]; routes: string[] } {
  return { targets: [c.target], routes: c.routes };
}
