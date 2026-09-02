/**
 * Backlog: the adjudicated findings ledger for a project. Pure functions only
 * (no I/O) so every transition is unit-testable.
 *
 * The idiom: every finding carries
 * a status, by-design and blocked REQUIRE prose reasons, merges dedupe by a
 * stable fingerprint, and `backlog check` fails on schema violations and
 * staleness instead of letting drift accumulate silently.
 */
import type { Category } from "../judge/rubric.js";
import type { Region } from "./region.js";
import type { DeterministicFinding, FormFactor, PlatformKind, Scheme, Severity } from "../types.js";
import type { AcceptanceCriterion } from "../issues/acceptance.js";

export type FindingStatus = "open" | "fixed" | "by-design" | "blocked";
export type Channel = "ai" | "deterministic" | "code";

/** The rendering element a finding was joined to at capture time. */
export interface RenderedBy {
  component: string | null;
  /** Source file per the page's own dev tooling; verified before printing. */
  file: string | null;
  line: number | null;
  /** The check's own selector, as it fired. */
  selector: string;
  /** The provenance walk's stable path to the joined element. */
  cssPath: string;
}

export interface EvidenceRef {
  shotId: string;
  path: string;
  hash: string;
  runId: string;
}

/**
 * Where a code-channel finding lives. A defect the source scanner found is not
 * on a screen, it is in a file, so it carries a file instead of a screenshot.
 */
export interface SourceRef {
  /** Absolute path, for whoever has to open it. */
  path: string;
  /** Repo-relative, so the fingerprint survives moving the checkout. */
  relPath: string;
  /** The declaration's name, when one could be read. */
  symbol: string | null;
  /** 1-based line of the declaration. */
  line: number;
  /**
   * Which oracle found it, and therefore which one has to agree it is gone.
   * Absent on findings filed before the conformance skill existed. The ruling
   * reads absence as skill-found, the conservative way round: the scanner by
   * design cannot see what the skill files, so its silence about a finding of
   * unknown provenance proves nothing. Reading absence as scan-found closed
   * defects nothing had re-read.
   */
  foundBy?: "scan" | "skill";
  /** The conformance skill's account of the component, when a skill found it. */
  note?: string;
}

/**
 * What the check that filed a deterministic finding recorded, bounded. The
 * prose in `problem` is written from this at ingestion; keeping the record
 * itself is what lets the document list every element a rule fired on and
 * lets the prose be rewritten later without a re-capture.
 */
export interface CheckRecord {
  type: DeterministicFinding["type"];
  meta?: Record<string, unknown>;
}

/**
 * How the view was photographed, as capture recorded it: what a fixer needs
 * to put the same screen in front of themselves. Constant per finding, since
 * the fingerprint fixes the view; refreshed on re-sighting. Every field is
 * optional because older captures recorded none of them.
 */
export interface ViewFacts {
  url?: string;
  finalUrl?: string;
  /** The simulator or emulator a device shot was taken on. */
  device?: { id: string; name: string };
  viewport?: { width: number; height: number };
  dpr?: number;
  schemeMechanism?: string;
  element?: string;
  stateDescription?: string;
  stateAffordance?: { selector: string; role: string; name: string; href: string | null; outcome?: string };
  design?: string;
  designHash?: string;
  provenance?: string;
}

export interface BacklogFinding {
  fingerprint: string;
  target: string;
  /**
   * Where the defect is. A route for anything photographed; the repo-relative
   * source path for a code-channel finding, which is the same question asked of
   * a file rather than of a screen.
   */
  route: string;
  state: string;
  /**
   * The capture axes. Absent on a code-channel finding, which was read out of
   * the source rather than photographed: there is no viewport at which a
   * hand-rolled component is or is not a duplicate. They are optional rather
   * than filled with a plausible default so that the compiler finds every place
   * that assumes a finding came from a screenshot.
   */
  platform?: PlatformKind;
  formFactor?: FormFactor;
  scheme?: Scheme;
  /** Set on code-channel findings only. */
  source?: SourceRef;
  /**
   * Which part of the frame the defect lives in. Absent and "content" are not
   * the same fact, and the shell migration turns on the difference: absent
   * means nothing has ever asked, so the record was filed before regions
   * existed and may be absorbed into a shell finding; "content" means the
   * question WAS asked and answered "the route's own body", and an answer is
   * never overridden by a later claim about a different screen.
   */
  region?: Region;
  /**
   * Every route this defect has been photographed on. Carried only when the
   * identity no longer names one: `route` keeps the first as provenance, and
   * this is what a fix verification has to cover.
   */
  seenRoutes?: string[];
  /** The route-scoped fingerprints this record absorbed when it collapsed. */
  absorbed?: string[];
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
   * The judge panel that owns this finding's category, stamped at ingestion
   * so the ticket can say which specialist filed it and an amendment can
   * target that specialist's skill. AI channel only; refreshed on
   * re-sighting so a category that moves panels follows its current owner.
   * Never part of the fingerprint.
   */
  judge?: string;
  /**
   * The element that was rendering this defect, joined exactly at capture
   * time (deterministic channel: the check's own selector re-queried against
   * the live page and matched to the provenance walk). Never part of the
   * fingerprint; refreshed on re-sighting.
   */
  renderedBy?: RenderedBy;
  /**
   * What the judge said would prove this defect gone. Deterministic findings
   * derive theirs instead, so this is empty for them.
   */
  acceptance?: string[];
  /** Deterministic channel only: what the check recorded, bounded. */
  check?: CheckRecord;
  /** Photographed findings only: how the view was captured. */
  view?: ViewFacts;
  /**
   * AI channel only: the adversarial verifier's own account of why the
   * finding stood, in its words. A second, independent description of the
   * defect, and the sentence a fixer who doubts the first one reads.
   */
  verifierNote?: string;
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
 * is the only place it exists, which is why it lives in backlog.json rather
 * than in the capture workspace: the workspace, under the operator's lookout
 * home, is working state one capture rebuilds, and a clean there would
 * re-roll every id and orphan every issue folder on disk. (The backlog
 * belongs to the project's own `.lookout/`; it is durable relative to the
 * capture workspace, which keeps nothing.)
 *
 * Nothing is ever pruned. An issue that was fixed years ago keeps its number,
 * so a commit message or a conversation that names it still resolves.
 */
export interface IssueRecord {
  /** Six digits. The handle for `verify-fix --issue` and the folder name. */
  id: string;
  /** The deterministic cluster key this id was minted for. */
  key: string;
  /**
   * Keys this id answered to before its cluster key was re-derived under new
   * rules, oldest first. Nothing is ever removed: a commit message naming the
   * old key still resolves through here.
   */
  priorKeys?: string[];
  createdAt: string;
  /**
   * Set when this issue was first seen in the run that verified a fix for
   * another one, on a screenshot whose pixels that fix had moved. Provenance,
   * not blame: the issue that caused it is not reopened or marked regressed.
   */
  causedBy?: { issue: string; commit: string | null; runId: string; at: string };
  /**
   * Ruled intentional as a whole. The per-finding by-design status suppresses
   * the fingerprints that exist when the ruling is made; this is what a
   * FUTURE sibling inherits, arriving as a visible by-design record instead
   * of reopening the issue. Cleared when the issue is reopened.
   */
  byDesign?: { reason: string; at: string };
  /**
   * Filed away by hand, once there was nothing left to do about it.
   *
   * Distinct from every status a finding carries, because it is not a verdict
   * about the defect: lookout already ruled on that. It is a person saying
   * they have seen the outcome and want it off the board. `reason` keeps which
   * outcome it was, so an issue archived after a fix is never described as one
   * somebody decided was intentional.
   *
   * Cleared automatically if the defect comes back: a reopened finding is live
   * work again, and work nobody can see is work nobody does.
   */
  archived?: { at: string; reason: "fixed" | "intentional" };
  /**
   * What would prove this issue fixed. Composed from its findings when the
   * issue is reconciled, and ruled only by `verify-fix`: there is no path by
   * which a person ticks one of these.
   */
  acceptance?: AcceptanceCriterion[];
  /**
   * Where the fix belongs, in a project that has a design system.
   *
   * Worked out once, when the issue is first filed, and kept. The issue folder
   * is rewritten on every backlog save, so deriving this at render time would
   * re-ask a model the same question on every adjudication; and the answer is
   * about the shape of the codebase, which does not change because somebody
   * marked a different issue by-design.
   *
   * Absent on issues filed before the project had a design system, and on
   * projects that do not have one. Nothing downstream requires it.
   */
  placement?: IssuePlacement;
}

/** The stored form of a placement verdict. See src/design/placement.ts. */
export interface IssuePlacement {
  kind: "kit-component" | "app-composition" | "tokens" | "kit-gap" | "unclear";
  /** The file to change. Absolute, and checked to exist when it was written. */
  primaryPath: string | null;
  symbol: string | null;
  reason: string;
  otherCallers: number | null;
  blastRadius: string;
  alsoRead: string[];
  notes: string;
  /** The kit this was reasoned against, so a stale placement is recognisable. */
  kit: string;
  /** Whether that kit is this repository's to edit. */
  kitEditable: boolean;
  at: string;
}

export interface Backlog {
  note: string;
  project: string;
  updatedAt: string;
  /**
   * Which shape this file is in. Absent means 1, the pre-region shape; the
   * one-shot migrations that run on load key off it.
   */
  schema?: 2;
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

// The rest of the backlog lives beside this file, and is re-exported here
// because this is the module every caller has always imported it from: the
// shapes above are what most of them want, and the behaviour below is what the
// backlog verb and the ingestion path want. Nothing here is a facade over
// anything: each name is defined in exactly one place.
export { fingerprintOf, sourceFingerprintOf } from "./fingerprint.js";
export { REGIONS, isShellRegion, parseRegion, type Region } from "./region.js";
export {
  aiToFindings,
  deterministicToFindings,
  handRollsToFindings,
  wasPhotographed,
  type PhotographedFinding,
} from "./ingest.js";
export { mergeFindings, setStatus, type MergeResult } from "./merge.js";
export { checkBacklog, type CheckProblem, failing } from "./check.js";
export { renderMarkdown, stats } from "./report.js";
