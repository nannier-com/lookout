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
import {
  clusterFindings,
  clusterKeyOf,
  priorClusterKeyOf,
  type ClusterOptions,
  type FixCluster,
} from "../fix/cluster.js";
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
  }

  // Succession before minting: a cluster key that changed shape under new
  // derivation rules (a chrome a11y cluster moving from its route to its
  // region) keeps its id, its folder and its ruled acceptance, rather than
  // minting a fresh number and orphaning the old one. A key succeeds only
  // when the evidence is unambiguous: every member of the new cluster names
  // the same predecessor key, that record exists, and it holds no members of
  // its own any more. Anything murkier mints, which is the safe direction:
  // a redundant id is noise, a stolen one is a lie.
  for (const [key, members] of membersByKey) {
    if (known.has(key)) continue;
    const priors = new Set(members.map((m) => priorClusterKeyOf(m)).filter((k): k is string => k !== null));
    if (priors.size !== 1) continue;
    const prior = [...priors][0]!;
    if (prior === key || membersByKey.has(prior)) continue;
    const record = Object.values(backlog.issues).find((r) => r.key === prior);
    if (!record) continue;
    record.priorKeys = [...(record.priorKeys ?? []), record.key];
    record.key = key;
    known.delete(prior);
    known.add(key);
  }

  for (const [key] of membersByKey) {
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

    // An archived issue whose defect came back is live work again. Leaving it
    // filed away would hide a defect lookout is currently re-finding, which is
    // the one thing an archive must never do.
    if (record.archived && members.some((m) => m.status === "open")) {
      delete record.archived;
    }
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

/** What happened when somebody asked to file an issue away, or bring it back. */
export type ArchiveOutcome =
  | { ok: true; record: IssueRecord; reason: "fixed" | "intentional" }
  | { ok: false; why: string };

/** The findings behind one issue record. */
function membersOf(backlog: Backlog, record: IssueRecord): BacklogFinding[] {
  return Object.values(backlog.findings).filter((f) => clusterKeyOf(f) === record.key);
}

/**
 * File an issue away.
 *
 * Not a verdict on the defect: lookout reached that already, and nothing here
 * touches a finding's status. This is a person saying they have seen the
 * outcome and want it off the board, so the only thing it refuses is archiving
 * work that is still open. Hiding a live defect is the one failure mode an
 * archive has, and it is worth one guard even though the button that calls this
 * is only drawn on settled issues.
 *
 * Idempotent: archiving an archived issue is what somebody double-clicking
 * means, not an error.
 */
export function archiveIssue(backlog: Backlog, id: string, now: string): ArchiveOutcome {
  const record = issueById(backlog, id);
  if (!record) return { ok: false, why: `no issue ${id}` };
  if (record.archived) return { ok: true, record, reason: record.archived.reason };

  const members = membersOf(backlog, record);
  if (members.length === 0) return { ok: false, why: `issue ${id} has no findings` };
  if (members.some((m) => m.status === "open")) {
    return { ok: false, why: `issue ${id} is still open; lookout has not ruled the defect gone` };
  }

  // Why it is being filed away, kept so the board never describes an issue
  // somebody fixed as one somebody decided was intentional.
  const reason = members.some((m) => m.status === "fixed") ? "fixed" : "intentional";
  record.archived = { at: now, reason };
  return { ok: true, record, reason };
}

/** Put an archived issue back on the board. The undo for the button above. */
export function unarchiveIssue(backlog: Backlog, id: string): ArchiveOutcome {
  const record = issueById(backlog, id);
  if (!record) return { ok: false, why: `no issue ${id}` };
  const reason = record.archived?.reason ?? "fixed";
  delete record.archived;
  return { ok: true, record, reason };
}
