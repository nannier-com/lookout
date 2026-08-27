/**
 * The issue registry: which six-digit id belongs to which root cause.
 *
 * Clustering is deterministic, so the KEY of an issue can always be recomputed
 * from its findings. The ID cannot: it was drawn at random the first time that
 * key was seen. This module is the one place that draw happens, and the one
 * place the mapping is read.
 *
 * It lives apart from `backlog/lib.ts` so that module stays pure data and
 * transitions, and apart from `fix/cluster.ts` so clustering stays a pure
 * function of findings. Minting is the only operation here that writes.
 */
import type { Backlog, BacklogFinding, IssueRecord } from "../backlog/lib.js";
import { composeAcceptance } from "./acceptance.js";
import type { Severity } from "../types.js";
import { clusterFindings, clusterKeyOf, type ClusterOptions, type FixCluster } from "../fix/cluster.js";
import { mintIssueId } from "./id.js";

/** Cluster key to issue id, which is what `clusterFindings` needs. */
export function issueIdsByKey(backlog: Backlog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rec of Object.values(backlog.issues ?? {})) out[rec.key] = rec.id;
  return out;
}

export function issueByKey(backlog: Backlog, key: string): IssueRecord | undefined {
  return Object.values(backlog.issues ?? {}).find((r) => r.key === key);
}

export function issueById(backlog: Backlog, id: string): IssueRecord | undefined {
  return (backlog.issues ?? {})[id];
}

/**
 * Give every root cause in the backlog an id, and return the ones just minted.
 *
 * Idempotent, and deliberately blind to status: a finding adjudicated by-design
 * years ago still has a folder somebody may open, so it keeps its number. Ids
 * are never pruned and never reused, so this only ever grows.
 *
 * Called from both load and save. On load it repairs a backlog written before
 * ids existed; on save it covers whatever the merge just added.
 */
export function reconcileIssues(
  backlog: Backlog,
  now: string,
  rng?: () => number,
): IssueRecord[] {
  if (!backlog.issues) backlog.issues = {};
  const taken = new Set(Object.keys(backlog.issues));
  const known = new Set(Object.values(backlog.issues).map((r) => r.key));
  const minted: IssueRecord[] = [];

  const membersByKey = new Map<string, BacklogFinding[]>();
  for (const finding of Object.values(backlog.findings)) {
    const key = clusterKeyOf(finding);
    const members = membersByKey.get(key) ?? [];
    members.push(finding);
    membersByKey.set(key, members);

    if (known.has(key)) continue;
    const id = mintIssueId(taken, rng);
    const record: IssueRecord = { id, key, createdAt: now };
    backlog.issues[id] = record;
    taken.add(id);
    known.add(key);
    minted.push(record);
  }

  // Every issue states what would prove it fixed, from the moment it is filed.
  // Composition keeps whatever has already been ruled: the criteria are matched
  // by an id derived from their own text, so a merge that adds a finding adds
  // criteria without forgetting the verdicts on the ones already there.
  for (const record of Object.values(backlog.issues)) {
    const members = [...(membersByKey.get(record.key) ?? [])].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.fingerprint.localeCompare(b.fingerprint),
    );
    record.acceptance = composeAcceptance(members, record.acceptance ?? []);
  }
  return minted;
}

/** Worst first, then by fingerprint: the order criteria are read in. */
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Every status an issue can be in and still be worth looking at: all of them. */
export const ALL_STATUSES = ["open", "blocked", "fixed", "by-design"] as const;

/**
 * The backlog's issues, with their ids resolved. Every caller that clusters
 * goes through here, so nobody has to remember to pass the registry in.
 */
export function issuesOf(backlog: Backlog, opts: ClusterOptions = {}): FixCluster[] {
  return clusterFindings(Object.values(backlog.findings), {
    statuses: [...ALL_STATUSES],
    ...opts,
    issueIds: issueIdsByKey(backlog),
  });
}

/** One issue by its six-digit id. */
export function findIssue(backlog: Backlog, id: string, opts: ClusterOptions = {}): FixCluster | undefined {
  return issuesOf(backlog, opts).find((c) => c.id === id);
}
