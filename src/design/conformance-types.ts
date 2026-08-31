/**
 * What the conformance pass hands around.
 *
 * Types only, so the three files that make up the pass can name the same things
 * without importing each other's machinery: choosing files, reading one batch,
 * and running the sweep are separate jobs that share one vocabulary.
 */
import type { HandRoll } from "./inventory.js";

export interface ConformanceFinding extends HandRoll {
  foundBy: "skill";
  confidence: "high" | "medium" | "low";
}

/** A suspicion the skill looked at and killed. */
export interface Refutation {
  relPath: string;
  symbol: string;
  why: string;
}

export interface ConformanceResult {
  /** Hand-rolled controls the skill found and lookout could verify. */
  handRolls: ConformanceFinding[];
  /** Scanner suspicions the skill read and rejected. */
  refuted: Refutation[];
  /** Files with a verdict this run, whether read fresh or carried from the cache. */
  examined: string[];
  /**
   * Files chosen for reading that came back with no verdict: a batch that
   * failed, or a reply that left them out. Not clean, not read, and never
   * cached, so the next run asks again. Ruling a fix on a file in this list is
   * refused outright.
   */
  unread: string[];
  /** Files carried from the cache because their bytes had not changed. */
  cached: number;
  /** Files chosen for reading, whether or not the skill accounted for them. */
  considered: number;
  /** Claims thrown out because the file, the symbol or the export did not check out. */
  rejected: { reason: string; raw: unknown }[];
  costUsd: number;
  /** Model calls spent. */
  calls: number;
}

export interface Candidate {
  path: string;
  relPath: string;
  /** Raw-element weight, for choosing what is worth reading. */
  score: number;
  /** What the deterministic scan suspected here, if anything. */
  suspicions: HandRoll[];
  /** The file's bytes as they were when it was chosen, for the cache key. */
  hash: string;
}

/** What one batch produced, before it is folded into the run's result. */
export interface BatchOutcome {
  findings: ConformanceFinding[];
  refuted: Refutation[];
  examined: string[];
  unread: string[];
  rejected: { reason: string; raw: unknown }[];
  /** Per-file verdicts, for the cache. A file missing here has no verdict. */
  decided: Map<string, { findings: ConformanceFinding[]; refuted: Refutation[] }>;
  costUsd: number;
  calls: number;
}

export interface RawFinding {
  path?: unknown;
  symbol?: unknown;
  line?: unknown;
  elements?: unknown;
  kitComponent?: unknown;
  what?: unknown;
  why?: unknown;
  confidence?: unknown;
}

export interface ConformanceOptions {
  model?: string;
  /**
   * How many files to read at most. Zero reads nothing, because this is a cap
   * on spending and a cap that means "unlimited" at zero is a way to spend a
   * lot of somebody's money by typing the smallest number they could think of.
   */
  fileBudget?: number;
  /** Read only these files, for ruling on one issue rather than sweeping. */
  only?: string[];
  /** Set false to read every candidate fresh, ignoring and not writing the cache. */
  cache?: boolean;
}
