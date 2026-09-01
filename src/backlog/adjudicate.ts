/**
 * Adjudicating a whole issue at once.
 *
 * A ruling is about the root cause, and the root cause is the issue: ruling
 * one fingerprint by-design while its twelve siblings stay open leaves the
 * issue reopening forever, which is how a chrome defect across many routes,
 * form factors and schemes could never settle. The fan-out applies the same
 * per-finding transition the CLI has always offered, so nothing about a
 * finding's own record changes shape; what is new is the durable half on the
 * issue itself, which is what lets a sibling that does not exist yet arrive
 * already ruled.
 */
import type { Backlog, FindingStatus, IssueRecord } from "./lib.js";
import { setStatus } from "./merge.js";
import { clusterKeyOf } from "../fix/cluster.js";

export function setIssueStatus(
  backlog: Backlog,
  issueId: string,
  status: FindingStatus,
  opts: { reason?: string; commit?: string; runId: string; now: string },
): { record: IssueRecord; fingerprints: string[] } {
  const record = (backlog.issues ?? {})[issueId];
  if (!record) throw new Error(`no issue with id "${issueId}"`);
  const members = Object.values(backlog.findings).filter(
    (f) => clusterKeyOf(f) === record.key,
  );
  if (members.length === 0) {
    throw new Error(`issue ${issueId} ("${record.key}") holds no findings to adjudicate`);
  }
  for (const m of members) setStatus(backlog, m.fingerprint, status, opts);

  // The durable half. A per-finding by-design suppresses only the fingerprints
  // that exist today; the issue-level ruling is what a future sibling (a new
  // route, a form factor never captured before) inherits on arrival.
  if (status === "by-design") {
    record.byDesign = { reason: opts.reason!.trim(), at: opts.now };
  } else if (status === "open") {
    delete record.byDesign;
  }
  return { record, fingerprints: members.map((m) => m.fingerprint) };
}

/**
 * The issue-level ruling an incoming finding inherits, if any: the record
 * whose cluster key it would land under, when that issue was ruled by-design
 * as a whole.
 */
export function inheritedByDesign(
  backlog: Backlog,
  f: Parameters<typeof clusterKeyOf>[0],
): { issue: IssueRecord; reason: string } | undefined {
  const key = clusterKeyOf(f);
  const record = Object.values(backlog.issues ?? {}).find((r) => r.key === key);
  return record?.byDesign ? { issue: record, reason: record.byDesign.reason } : undefined;
}
