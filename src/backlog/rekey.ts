/**
 * Folding route-scoped history into a shell finding.
 *
 * The moment the judge first places a defect in a shell region, its identity
 * stops naming a route, and whatever the backlog already holds about the same
 * defect under route-scoped fingerprints is the same work under old names.
 * Absorbing folds those records into the one shell record, so the defect
 * arrives with its history: its age, its attempts, its evidence, and above
 * all its adjudication, because a by-design ruling somebody wrote must win
 * over a fresh sighting whichever key it was recorded under.
 *
 * Only records that were never asked about their region are eligible. An
 * explicit "content" is an answer, and an answer is never overridden by a
 * later claim about a different screen: if the judge once said a defect was
 * the route's own, a shell claim elsewhere is a different defect until a
 * person says otherwise.
 */
import type { Backlog, BacklogFinding } from "./lib.js";
import { isShellRegion } from "./region.js";

/** One collapse, for the merge result and the run summary. */
export interface Absorption {
  fingerprint: string;
  from: string[];
}

/**
 * Chronology of run ids. `web-20260831-212625` and `check-20260830-011500`
 * do not sort lexically against each other, but both carry their moment.
 * An id without one sorts oldest, which only ever widens `firstSeen`.
 */
export function runOrder(runId: string): string {
  return /(\d{8}-\d{6})/.exec(runId)?.[1] ?? "";
}

/** Lower wins. Adjudications outrank live work; live work outranks settled. */
const STATUS_RANK: Record<BacklogFinding["status"], number> = {
  "by-design": 0,
  blocked: 1,
  open: 2,
  fixed: 3,
};

/**
 * Fold every legacy sibling of an incoming shell finding into one record at
 * the shell fingerprint, or return undefined when there is nothing to fold.
 * The caller then runs its ordinary state machine against the folded record,
 * so a folded by-design suppresses the sighting and a folded fixed reopens.
 */
export function absorbLegacy(
  backlog: Backlog,
  f: Pick<
    BacklogFinding,
    | "fingerprint"
    | "target"
    | "route"
    | "state"
    | "formFactor"
    | "scheme"
    | "category"
    | "attribute"
    | "channel"
  > & { region?: BacklogFinding["region"] },
): BacklogFinding | undefined {
  // Both halves checked: the region says shell, and the fingerprint proves the
  // identity was actually derived from it (the @ sigil is unreachable any
  // other way). While the transition flag keeps identity route-keyed, a shell
  // region rides on a route fingerprint and folding onto THAT would be the
  // collapse running with the flag off.
  if (!isShellRegion(f.region) || !f.fingerprint.includes(`@${f.region}`)) return undefined;
  const ancestors = Object.values(backlog.findings).filter(
    (r) =>
      r.region === undefined &&
      r.target === f.target &&
      r.state === f.state &&
      r.formFactor === f.formFactor &&
      r.scheme === f.scheme &&
      r.category === f.category &&
      r.attribute === f.attribute &&
      r.channel === f.channel,
  );
  if (ancestors.length === 0) return undefined;

  const byAge = [...ancestors].sort(
    (a, b) => runOrder(a.firstSeen).localeCompare(runOrder(b.firstSeen)) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  const winner = [...ancestors].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
  )[0]!;
  const oldest = byAge[0]!;
  const newest = byAge[byAge.length - 1]!;

  // Newest evidence wins the cap, exactly as the refresh path keeps it.
  const evidence = ancestors
    .flatMap((r) => r.evidence)
    .filter((ev, i, all) => all.findIndex((e) => e.hash === ev.hash) === i)
    .sort((a, b) => runOrder(a.runId).localeCompare(runOrder(b.runId)))
    .slice(-6);

  const carriesReason = winner.status === "by-design" || winner.status === "blocked";
  const folded: BacklogFinding = {
    ...winner,
    fingerprint: f.fingerprint,
    region: f.region,
    // Provenance, not identity: the screen this was first photographed on.
    route: oldest.route,
    seenRoutes: [...new Set([...ancestors.map((r) => r.route), f.route])].sort(),
    absorbed: ancestors.map((r) => r.fingerprint).sort(),
    status: winner.status,
    reason: carriesReason ? `absorbed from ${winner.fingerprint}: ${winner.reason}` : null,
    firstSeen: oldest.firstSeen,
    lastSeen: newest.lastSeen,
    fixAttempts: Math.max(...ancestors.map((r) => r.fixAttempts)),
    fixedIn:
      winner.status === "fixed"
        ? (byAge.filter((r) => r.fixedIn).map((r) => r.fixedIn).at(-1) ?? null)
        : null,
    verified: ancestors.some((r) => r.verified),
    evidence,
  };

  for (const r of ancestors) delete backlog.findings[r.fingerprint];
  backlog.findings[f.fingerprint] = folded;
  return folded;
}
