/**
 * Is this backlog still telling the truth?
 *
 * A backlog is a file people and agents both write, and it goes stale in
 * specific ways: a status set without the reason the format requires, a
 * fingerprint that no longer parses, evidence pointing at a screenshot nobody
 * kept. Each of those is a problem this reports rather than a crash somewhere
 * later, which is the whole point of `lookout backlog check`.
 */
import { CATEGORIES } from "../judge/rubric.js";
import { clusterKeyOf } from "../fix/cluster.js";
import { isIssueId } from "../issues/id.js";
import { renderMarkdown } from "./report.js";
import type { CaptureReport } from "../types.js";
import type { Backlog } from "./lib.js";

// Validation / staleness (`backlog check`)

export interface CheckProblem {
  kind:
    | "schema"
    | "reason-missing"
    | "unknown-category"
    | "stale-md"
    | "drift-resolved"
    | "issue-missing"
    | "issue-schema"
    | "acceptance-missing";
  fingerprint?: string;
  message: string;
}

export function checkBacklog(
  backlog: Backlog,
  opts: { mdOnDisk: string | null; latestReport: CaptureReport | null },
): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const [fp, f] of Object.entries(backlog.findings)) {
    if (fp !== f.fingerprint) {
      problems.push({ kind: "schema", fingerprint: fp, message: `key "${fp}" != fingerprint "${f.fingerprint}"` });
    }
    if (!(CATEGORIES as readonly string[]).includes(f.category)) {
      problems.push({ kind: "unknown-category", fingerprint: fp, message: `category "${f.category}"` });
    }
    if ((f.status === "by-design" || f.status === "blocked") && !f.reason?.trim()) {
      problems.push({ kind: "reason-missing", fingerprint: fp, message: `status ${f.status} without a reason` });
    }
    if (!["open", "fixed", "by-design", "blocked"].includes(f.status)) {
      problems.push({ kind: "schema", fingerprint: fp, message: `unknown status "${f.status}"` });
    }
  }

  // Every root cause holds an id, and every id is well formed and holds the
  // key it was minted for. A finding whose issue is missing has a folder
  // nobody can find and an id nobody can type.
  const issues = backlog.issues ?? {};
  const keysWithIds = new Set<string>();
  for (const [id, record] of Object.entries(issues)) {
    if (id !== record.id) {
      problems.push({ kind: "issue-schema", message: `issue key "${id}" != id "${record.id}"` });
    }
    if (!isIssueId(record.id)) {
      problems.push({ kind: "issue-schema", message: `issue id "${record.id}" is not six digits` });
    }
    if (keysWithIds.has(record.key)) {
      problems.push({
        kind: "issue-schema",
        message: `two issues claim the root cause "${record.key}"`,
      });
    }
    // An issue nobody can test is an issue nobody can close. Same standing as
    // the mandatory reason on a by-design finding: the record has to say what
    // would settle it.
    if (!record.acceptance || record.acceptance.length === 0) {
      problems.push({
        kind: "acceptance-missing",
        message: `issue ${record.id} has no acceptance criteria; run \`lookout backlog regen\``,
      });
    }
    keysWithIds.add(record.key);
  }
  for (const [fp, f] of Object.entries(backlog.findings)) {
    const key = clusterKeyOf(f);
    if (!keysWithIds.has(key)) {
      problems.push({
        kind: "issue-missing",
        fingerprint: fp,
        message: `no issue id for root cause "${key}"; run \`lookout backlog regen\``,
      });
    }
  }

  if (opts.mdOnDisk !== null && opts.mdOnDisk !== renderMarkdown(backlog)) {
    problems.push({
      kind: "stale-md",
      message: "BACKLOG.md does not match backlog.json; run `lookout backlog regen`",
    });
  }

  // An open finding whose exact shot was re-captured in the newest run but
  // which no merge refreshed is likely fixed by drift: flag for adjudication.
  if (opts.latestReport && opts.latestReport.runs.length > 0) {
    const latest = opts.latestReport.runs[opts.latestReport.runs.length - 1]!;
    const capturedShotIds = new Set(
      opts.latestReport.shots.filter((s) => s.runId === latest.id).map((s) => s.id),
    );
    for (const [fp, f] of Object.entries(backlog.findings)) {
      if (f.status !== "open") continue;
      const covered = f.evidence.some((e) => capturedShotIds.has(e.shotId));
      if (covered && f.lastSeen !== latest.id) {
        problems.push({
          kind: "drift-resolved",
          fingerprint: fp,
          message: `open finding not re-found in run ${latest.id}; mark fixed or investigate`,
        });
      }
    }
  }

  return problems;
}
