/**
 * The state machine: what happens when a finding is seen again.
 *
 * Every rule here is about not losing an adjudication. A defect somebody ruled
 * by-design must not come back as new work the next time the judge files it; a
 * fixed finding that reappears must reopen rather than arrive as a second
 * issue; and a finding still open when it is seen again is refreshed, not
 * duplicated. Status transitions live here for the same reason: they are the
 * other half of the same machine.
 */
import { deterministicToFindings } from "./ingest.js";
import { inheritedByDesign } from "./adjudicate.js";
import { absorbLegacy, type Absorption } from "./rekey.js";
import type { Backlog, BacklogFinding, FindingStatus } from "./lib.js";

// Merge: the dedupe/reopen/suppress state machine.

export interface MergeResult {
  added: string[];
  refreshed: string[]; // existing open findings seen again
  reopened: string[]; // fixed findings that came back
  suppressed: string[]; // by-design findings dropped silently
  /** Shell findings that folded route-scoped history into themselves. */
  absorbed: Absorption[];
}

export function mergeFindings(
  backlog: Backlog,
  incoming: ReturnType<typeof deterministicToFindings>,
  runId: string,
  now: string,
): MergeResult {
  const res: MergeResult = { added: [], refreshed: [], reopened: [], suppressed: [], absorbed: [] };
  for (const f of incoming) {
    let existing = backlog.findings[f.fingerprint];
    if (!existing) {
      // A shell fingerprint arriving for the first time may be old work under
      // a new name: fold the route-scoped records it supersedes, BEFORE the
      // by-design branch, so an absorbed adjudication suppresses the sighting
      // exactly as it would have under the old key.
      const folded = absorbLegacy(backlog, f);
      if (folded) {
        existing = folded;
        res.absorbed.push({ fingerprint: f.fingerprint, from: folded.absorbed ?? [] });
      }
    }
    if (!existing) {
      // A sibling arriving under an issue somebody ruled intentional as a
      // whole is born ruled, visibly: it lands in the backlog's by-design
      // section where it can be individually reopened, rather than being
      // swallowed or reopening a settled issue.
      const inherited = inheritedByDesign(backlog, f);
      backlog.findings[f.fingerprint] = {
        ...f,
        status: inherited ? "by-design" : "open",
        reason: inherited
          ? `${inherited.reason} (inherited from issue ${inherited.issue.id})`
          : null,
        firstSeen: runId,
        lastSeen: runId,
        fixAttempts: 0,
        fixedIn: null,
      };
      (inherited ? res.suppressed : res.added).push(f.fingerprint);
      continue;
    }
    if (existing.status === "by-design") {
      res.suppressed.push(f.fingerprint);
      continue;
    }
    // Fresh evidence and prose refresh the record either way.
    existing.lastSeen = runId;
    // A region is adopted where none was ever recorded and never overwritten:
    // absent means the question was never asked, so a fresh answer is strictly
    // more information; a recorded answer standing against a new claim is a
    // disagreement, and identity must not wobble with it.
    if (existing.region === undefined && f.region !== undefined) existing.region = f.region;
    existing.severity = f.severity;
    existing.title = f.title;
    existing.problem = f.problem;
    existing.expected = f.expected;
    existing.observed = f.observed;
    existing.verified = f.verified || existing.verified;
    for (const ev of f.evidence) {
      if (!existing.evidence.some((e) => e.hash === ev.hash)) {
        existing.evidence.push(ev);
        if (existing.evidence.length > 6) existing.evidence.shift();
      }
    }
    if (existing.status === "fixed") {
      existing.status = "open";
      existing.fixedIn = null;
      res.reopened.push(f.fingerprint);
    } else {
      res.refreshed.push(f.fingerprint);
    }
  }
  backlog.updatedAt = now;
  return res;
}

// Status transitions

export function setStatus(
  backlog: Backlog,
  fingerprint: string,
  status: FindingStatus,
  opts: { reason?: string; commit?: string; runId: string; now: string },
): BacklogFinding {
  const f = backlog.findings[fingerprint];
  if (!f) throw new Error(`no finding with fingerprint "${fingerprint}"`);
  if ((status === "by-design" || status === "blocked") && !opts.reason?.trim()) {
    throw new Error(`status ${status} requires --reason (the adjudication must be explainable)`);
  }
  f.status = status;
  f.reason = status === "by-design" || status === "blocked" ? opts.reason!.trim() : null;
  if (status === "fixed") {
    f.fixedIn = { commit: opts.commit ?? null, runId: opts.runId };
  } else if (status === "open") {
    f.fixedIn = null;
  }
  if (status === "blocked") f.fixAttempts += 1;
  backlog.updatedAt = opts.now;
  return f;
}
