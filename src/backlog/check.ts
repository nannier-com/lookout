/**
 * Is this backlog still telling the truth?
 *
 * A backlog is a file people and agents both write, and it goes stale in
 * specific ways: a status set without the reason the format requires, a
 * fingerprint that no longer parses, evidence pointing at a screenshot nobody
 * kept. Each of those is a problem this reports rather than a crash somewhere
 * later, which is the whole point of `lookout backlog check`.
 */
import { DETERMINISTIC_TYPES } from "./ingest.js";
import { problemLapses } from "./prose.js";
import { CATEGORIES } from "../judge/rubric.js";
import { panelOf } from "../judge/panels.js";
import { clusterKeyOf } from "../fix/cluster.js";
import { wasPhotographed } from "./ingest.js";
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
    | "issue-orphaned"
    | "issue-schema"
    | "acceptance-missing"
    | "frames-missing"
    | "problem-unexplained";
  /** A warning is reported and does not fail the check unless asked to (`--strict`). */
  level?: "warning";
  fingerprint?: string;
  message: string;
}

/** The problems that fail the check: every error, plus the warnings when strict. */
export function failing(problems: CheckProblem[], strict = false): CheckProblem[] {
  return problems.filter((p) => strict || p.level !== "warning");
}

/** The panel owning a category, or null for one outside the registry. */
function ownerOrNull(category: string): string | null {
  try {
    return panelOf(category).name;
  } catch {
    return null;
  }
}

export function checkBacklog(
  backlog: Backlog,
  opts: {
    mdOnDisk: string | null;
    latestReport: CaptureReport | null;
    /**
     * Pre-fix frames frozen per issue id. Omitted by a caller that cannot read
     * the issue folders, and then the frames are not checked at all rather
     * than reported missing on no evidence.
     */
    framesByIssue?: Record<string, number>;
    /**
     * Which judge panels the latest judge run actually asked, from
     * judge-report.json. Omitted (or null) by a caller without a report, and
     * then every covered-but-unrefreshed AI finding is flagged as before.
     */
    judgedPanels?: readonly string[] | null;
  },
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
    // Loose on purpose: not pinned to the live registry, so renaming a panel
    // never orphans an old backlog's stamps.
    if (f.judge !== undefined && (typeof f.judge !== "string" || f.judge.length === 0)) {
      problems.push({ kind: "schema", fingerprint: fp, message: "judge must be a non-empty string when present" });
    }
    if (f.check !== undefined && !(DETERMINISTIC_TYPES as string[]).includes(f.check.type)) {
      problems.push({ kind: "schema", fingerprint: fp, message: `unknown check type "${String(f.check.type)}"` });
    }
    // A problem written for one reader is a record a person cannot act on
    // without the screenshot. It is still a real finding, so this is advice
    // by default and a failure only under --strict.
    const lapses = problemLapses(f);
    if (lapses.length > 0) {
      problems.push({ kind: "problem-unexplained", level: "warning", fingerprint: fp, message: `problem is written for one reader (${lapses.join(", ")})` });
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
  const liveKeys = new Set<string>();
  for (const [fp, f] of Object.entries(backlog.findings)) {
    const key = clusterKeyOf(f);
    liveKeys.add(key);
    if (!keysWithIds.has(key)) {
      problems.push({
        kind: "issue-missing",
        fingerprint: fp,
        message: `no issue id for root cause "${key}"; run \`lookout backlog regen\``,
      });
    }
  }

  // An issue whose key clusters nothing any more is a folder going stale on
  // disk: its members were absorbed into a shell finding, or adjudicated under
  // a key that has since been re-derived. Ids are never pruned, so this is a
  // report, not a deletion.
  for (const record of Object.values(issues)) {
    if (!liveKeys.has(record.key)) {
      problems.push({
        kind: "issue-orphaned",
        message: `issue ${record.id} ("${record.key}") holds no findings any more`,
      });
    }
  }

  // Every issue with a screenshot behind it should hold a pre-fix frame. One is
  // frozen when the issue is filed, so a missing frame means either an issue
  // filed before lookout froze anything, or evidence cleaned out of the store
  // before a save could copy it. Without it the card can only show that view's
  // current pixels, which stop being the defect at the next capture.
  if (opts.framesByIssue) {
    const photographed = new Set<string>();
    for (const f of Object.values(backlog.findings)) {
      if (wasPhotographed(f)) photographed.add(clusterKeyOf(f));
    }
    for (const record of Object.values(issues)) {
      if (!photographed.has(record.key)) continue;
      if ((opts.framesByIssue[record.id] ?? 0) > 0) continue;
      problems.push({
        kind: "frames-missing",
        message:
          `issue ${record.id} has no pre-fix screenshot; nothing froze one before ` +
          `the store was re-captured, and the card can only show these views as they are now`,
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
        // "Not asked" must never read as "not re-found": a panel-scoped run
        // (verify-fix pays only the owning panel) re-captures the pixels
        // without re-judging the other lanes, so an AI finding whose panel
        // sat out the last judge run is not drift, it is out of scope. A
        // category the registry does not know keeps flagging: conservatism
        // belongs on the side that surfaces a finding for a person.
        if (f.channel === "ai" && opts.judgedPanels) {
          const owner = ownerOrNull(f.category);
          if (owner && !opts.judgedPanels.includes(owner)) continue;
        }
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
