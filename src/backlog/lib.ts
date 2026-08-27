/**
 * Backlog: the adjudicated findings ledger for a project. Pure functions only
 * (no I/O) so every transition is unit-testable.
 *
 * The idiom (proven in canvas's handoff-parity tooling): every finding carries
 * a status, by-design and blocked REQUIRE prose reasons, merges dedupe by a
 * stable fingerprint, and `backlog check` fails on schema violations and
 * staleness instead of letting drift accumulate silently.
 */
import type {
  CaptureReport,
  DeterministicFinding,
  FormFactor,
  PlatformKind,
  Scheme,
  Severity,
  ShotRecord,
} from "../types.js";
import type { AiFinding } from "../judge/engine.js";
import { CATEGORIES, type Category } from "../judge/rubric.js";
import { routeSlug } from "../capture/store.js";
import { clusterKeyOf } from "../fix/cluster.js";
import { isIssueId } from "../issues/id.js";
import type { AcceptanceCriterion } from "../issues/acceptance.js";

export type FindingStatus = "open" | "fixed" | "by-design" | "blocked";
export type Channel = "ai" | "deterministic" | "code";

export interface EvidenceRef {
  shotId: string;
  path: string;
  hash: string;
  runId: string;
}

export interface BacklogFinding {
  fingerprint: string;
  target: string;
  route: string;
  state: string;
  platform: PlatformKind;
  formFactor: FormFactor;
  scheme: Scheme;
  category: Category;
  attribute: string;
  severity: Severity;
  status: FindingStatus;
  /** Mandatory prose for by-design and blocked. */
  reason: string | null;
  title: string;
  problem: string;
  expected: string;
  observed: string;
  channel: Channel;
  confidence: "high" | "medium" | "low";
  verified: boolean;
  /**
   * What the judge said would prove this defect gone. Deterministic findings
   * derive theirs instead, so this is empty for them.
   */
  acceptance?: string[];
  evidence: EvidenceRef[];
  firstSeen: string; // runId
  lastSeen: string; // runId
  fixAttempts: number;
  fixedIn: { commit: string | null; runId: string } | null;
}

/**
 * One issue: a root cause, its six-digit id, and where that id came from.
 *
 * The id is random, so unlike the `key` it cannot be recomputed. This registry
 * is the only place it exists, which is why it lives in backlog.json (committed)
 * rather than under evidence/ (gitignored): one `git clean` there would re-roll
 * every id and orphan every issue folder on disk.
 *
 * Nothing is ever pruned. An issue that was fixed years ago keeps its number,
 * so a commit message or a conversation that names it still resolves.
 */
export interface IssueRecord {
  /** Six digits. The handle for `verify-fix --issue` and the folder name. */
  id: string;
  /** The deterministic cluster key this id was minted for. */
  key: string;
  createdAt: string;
  /**
   * Set when this issue was first seen in the run that verified a fix for
   * another one, on a screenshot whose pixels that fix had moved. Provenance,
   * not blame: the issue that caused it is not reopened or marked regressed.
   */
  causedBy?: { issue: string; commit: string | null; runId: string; at: string };
  /**
   * What would prove this issue fixed. Composed from its findings when the
   * issue is reconciled, and ruled only by `verify-fix`: there is no path by
   * which a person ticks one of these.
   */
  acceptance?: AcceptanceCriterion[];
}

export interface Backlog {
  note: string;
  project: string;
  updatedAt: string;
  findings: Record<string, BacklogFinding>;
  /** Issue ids by id. Assigned once, never reused, never pruned. */
  issues: Record<string, IssueRecord>;
}

export const BACKLOG_NOTE =
  "lookout findings backlog. Every finding carries a status; by-design and blocked require prose reasons. " +
  "Findings group into issues, each with a six-digit id minted once and never reused; the id names the " +
  "issue's folder under .lookout/issues/. " +
  "Managed by `lookout backlog` (merge/set/reopen/regen/check); edit through the CLI, not by hand.";

export function emptyBacklog(project: string, now: string): Backlog {
  return { note: BACKLOG_NOTE, project, updatedAt: now, findings: {}, issues: {} };
}

// ---------------------------------------------------------------------------
// Fingerprints: the dedupe identity across runs. Axes only, no prose, so a
// re-found defect merges instead of duplicating.
// ---------------------------------------------------------------------------

export function fingerprintOf(f: {
  target: string;
  route: string;
  state: string;
  formFactor: FormFactor;
  scheme: Scheme;
  category: string;
  attribute: string;
}): string {
  return [
    f.target,
    routeSlug(f.route),
    f.state,
    f.formFactor,
    f.scheme,
    f.category,
    f.attribute,
  ].join(".");
}

// ---------------------------------------------------------------------------
// Ingestion mappers
// ---------------------------------------------------------------------------

const DETERMINISTIC_MAP: Record<
  DeterministicFinding["type"],
  { category: Category; attribute: string }
> = {
  "console-error": { category: "render-failure", attribute: "console-error" },
  "page-error": { category: "render-failure", attribute: "page-error" },
  "request-failed": { category: "render-failure", attribute: "request-failed" },
  "horizontal-overflow": { category: "layout-overflow", attribute: "horizontal-scroll" },
  "axe-violation": { category: "a11y", attribute: "axe" },
  "blank-shot": { category: "render-failure", attribute: "blank" },
  "capture-error": { category: "render-failure", attribute: "capture-error" },
  "scheme-mismatch": { category: "color-scheme", attribute: "scheme-mechanism" },
  "stale-frame": { category: "render-failure", attribute: "stale-frame" },
  "off-origin": { category: "render-failure", attribute: "off-origin" },
};

function severityFromDeterministic(f: DeterministicFinding): Severity {
  // Both mean the pixels are not the thing the shot claims to be, which makes
  // every other finding on that shot describe the wrong screen.
  if (f.type === "blank-shot" || f.type === "off-origin") return "critical";
  if (f.severity === "error") return "high";
  if (f.severity === "warning") return "medium";
  return "low";
}

/** Deterministic findings from a capture report, as backlog-shaped findings. */
export function deterministicToFindings(report: CaptureReport): Omit<BacklogFinding, "firstSeen" | "lastSeen" | "status" | "reason" | "fixAttempts" | "fixedIn">[] {
  const out: ReturnType<typeof deterministicToFindings> = [];
  for (const shot of report.shots) {
    for (const df of shot.deterministicFindings) {
      const map = DETERMINISTIC_MAP[df.type];
      // axe findings keep their ruleId as the attribute so different rules
      // stay distinct findings.
      const attribute =
        df.type === "axe-violation" && df.meta && typeof df.meta.ruleId === "string"
          ? `axe-${df.meta.ruleId}`
          : map.attribute;
      out.push({
        fingerprint: fingerprintOf({ ...shot, category: map.category, attribute }),
        target: shot.target,
        route: shot.route,
        state: shot.state,
        platform: shot.platform,
        formFactor: shot.formFactor,
        scheme: shot.scheme,
        category: map.category,
        attribute,
        severity: severityFromDeterministic(df),
        title: df.message.slice(0, 160),
        problem: df.message,
        expected: "",
        observed: "",
        channel: "deterministic",
        confidence: "high",
        verified: true,
        evidence: [{ shotId: shot.id, path: shot.path, hash: shot.hash, runId: shot.runId }],
      });
    }
  }
  return out;
}

/** AI findings (from a check run) joined with their shots. */
export function aiToFindings(
  findings: (AiFinding & { verified?: boolean })[],
  shotsById: Map<string, ShotRecord>,
): ReturnType<typeof deterministicToFindings> {
  const out: ReturnType<typeof deterministicToFindings> = [];
  for (const f of findings) {
    const shot = shotsById.get(f.shotId);
    if (!shot) continue;
    out.push({
      fingerprint: fingerprintOf({ ...shot, category: f.category, attribute: f.attribute }),
      target: shot.target,
      route: shot.route,
      state: shot.state,
      platform: shot.platform,
      formFactor: shot.formFactor,
      scheme: shot.scheme,
      category: f.category,
      attribute: f.attribute,
      severity: f.severity,
      title: f.title,
      problem: f.problem,
      expected: f.expected,
      observed: f.observed,
      channel: "ai",
      confidence: f.confidence,
      verified: !!f.verified,
      acceptance: f.acceptance ?? [],
      evidence: [{ shotId: shot.id, path: shot.path, hash: shot.hash, runId: shot.runId }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge: the dedupe/reopen/suppress state machine.
// ---------------------------------------------------------------------------

export interface MergeResult {
  added: string[];
  refreshed: string[]; // existing open findings seen again
  reopened: string[]; // fixed findings that came back
  suppressed: string[]; // by-design findings dropped silently
}

export function mergeFindings(
  backlog: Backlog,
  incoming: ReturnType<typeof deterministicToFindings>,
  runId: string,
  now: string,
): MergeResult {
  const res: MergeResult = { added: [], refreshed: [], reopened: [], suppressed: [] };
  for (const f of incoming) {
    const existing = backlog.findings[f.fingerprint];
    if (!existing) {
      backlog.findings[f.fingerprint] = {
        ...f,
        status: "open",
        reason: null,
        firstSeen: runId,
        lastSeen: runId,
        fixAttempts: 0,
        fixedIn: null,
      };
      res.added.push(f.fingerprint);
      continue;
    }
    if (existing.status === "by-design") {
      res.suppressed.push(f.fingerprint);
      continue;
    }
    // Fresh evidence and prose refresh the record either way.
    existing.lastSeen = runId;
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

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation / staleness (`backlog check`)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Markdown report (deterministic render so `check` can byte-compare)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function stats(backlog: Backlog): {
  byStatus: Record<FindingStatus, number>;
  bySeverityOpen: Record<Severity, number>;
  total: number;
} {
  const byStatus: Record<FindingStatus, number> = { open: 0, fixed: 0, "by-design": 0, blocked: 0 };
  const bySeverityOpen: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of Object.values(backlog.findings)) {
    byStatus[f.status]++;
    if (f.status === "open") bySeverityOpen[f.severity]++;
  }
  return { byStatus, bySeverityOpen, total: Object.keys(backlog.findings).length };
}

export function renderMarkdown(backlog: Backlog): string {
  const s = stats(backlog);
  // The number people actually use, on the report people actually read. It is
  // also the folder holding this finding's screenshots and its history.
  const idFor = (f: BacklogFinding): string => {
    const key = clusterKeyOf(f);
    const record = Object.values(backlog.issues ?? {}).find((r) => r.key === key);
    return record?.id ?? "";
  };
  const all = Object.values(backlog.findings);
  const sorted = (list: BacklogFinding[]) =>
    [...list].sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.fingerprint.localeCompare(b.fingerprint),
    );
  const row = (f: BacklogFinding) =>
    `| ${idFor(f)} | \`${f.fingerprint}\` | ${f.severity} | ${f.channel}${f.verified ? " (verified)" : ""} | ${f.title.replace(/\|/g, "\\|")} | ${f.evidence[f.evidence.length - 1]?.path ?? ""} |`;

  const lines: string[] = [
    "<!-- Generated by `lookout backlog regen`. Do not edit by hand. -->",
    "",
    `# lookout backlog: ${backlog.project}`,
    "",
    `Updated ${backlog.updatedAt}. ${s.total} finding(s) in ${Object.keys(backlog.issues ?? {}).length} issue(s): ` +
      `${s.byStatus.open} open, ${s.byStatus.fixed} fixed, ${s.byStatus["by-design"]} by design, ${s.byStatus.blocked} blocked.`,
    `Open by severity: ${s.bySeverityOpen.critical} critical, ${s.bySeverityOpen.high} high, ${s.bySeverityOpen.medium} medium, ${s.bySeverityOpen.low} low.`,
    "",
  ];

  const section = (title: string, list: BacklogFinding[], withReason: boolean) => {
    lines.push(`## ${title}`, "");
    if (list.length === 0) {
      lines.push("None.", "");
      return;
    }
    lines.push(
      "| issue | fingerprint | severity | channel | title | evidence |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const f of sorted(list)) {
      lines.push(row(f));
      if (withReason && f.reason) {
        lines.push(`| | | | | reason: ${f.reason.replace(/\|/g, "\\|")} | |`);
      }
    }
    lines.push("");
  };

  section("Open", all.filter((f) => f.status === "open"), false);
  section("Blocked", all.filter((f) => f.status === "blocked"), true);
  section("By design", all.filter((f) => f.status === "by-design"), true);
  section("Fixed", all.filter((f) => f.status === "fixed"), false);

  return lines.join("\n");
}
