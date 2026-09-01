/**
 * What a board entry is: the contract between what lookout knows and what the
 * page draws.
 *
 * Its own module, and deliberately a leaf. The page's client modules import
 * these as types, and a browser bundle must not drag in the code that reads the
 * filesystem to produce them; keeping the shapes here means the import is
 * erased at compile time and there is nothing left to load. It is also the file
 * that changes when the board grows a field, which is a change two sessions
 * should be able to make without meeting in the middle of the builder.
 */
import type { AcceptanceCriterion } from "../issues/acceptance.js";

/**
 * Where an issue stands. Every state is one lookout established itself: the
 * backlog says open, blocked, fixed or waived, and `verify-fix` says what it
 * saw last time it was asked to rule. Nothing here tracks who is working on
 * it, because lookout does not dispatch work and cannot know.
 */
export type IssueStatus =
  | "open"
  | "verifying"
  | "still-open"
  | "blocked"
  /** lookout confirmed the defect is gone. */
  | "done"
  /**
   * Off the board and kept as record rather than as work: either adjudicated
   * intentional, or filed away by hand once lookout had ruled the defect gone.
   * `BoardEntry.archived` says which, because they are not the same thing.
   */
  | "archived";

/**
 * Read top to bottom, this is "what needs a person now" before "what is already
 * dealt with". Blocked sits above done and archived because lookout gave up on
 * it and the defect is still there.
 */
export const ORDER_BY_ATTENTION: Record<IssueStatus, number> = {
  verifying: 0,
  "still-open": 1,
  open: 2,
  blocked: 3,
  done: 4,
  archived: 5,
};

/**
 * A screenshot, as the page needs it.
 *
 * Both forms of the path are carried on purpose. `path` is evidence-relative
 * because that is what the server serves thumbnails from; `absPath` is what
 * gets shown and copied, because whoever picks this issue up needs a path they
 * can open without knowing where lookout keeps its evidence.
 */
export interface BoardShot {
  path: string;
  absPath: string;
  route: string;
  formFactor: string;
  scheme: string;
  state?: string;
  /**
   * When a frozen frame was taken. Absent on a live store shot, which has no
   * moment of its own: it is whatever that view rendered at the last capture.
   */
  at?: string;
}

/** One line in lookout's record of an issue. */
export interface BoardStep {
  at: string;
  kind: "found" | "claimed" | "verify" | "verdict";
  text: string;
}

export interface BoardEntry {
  /** Six digits. What the card shows, and what `--issue` takes. */
  id: string;
  /** The derived key behind it, for anyone debugging why two things grouped. */
  key: string;
  /** The issue's folder, absolute: everything about it is in there. */
  dir: string;
  /**
   * The issue's own document, absolute, or null when the folder holds none.
   *
   * Carried rather than derived from `dir`, because whether the file is there
   * is the question: the document is written when the backlog is saved, and an
   * issue whose folder has not been materialised has nothing to open. Null is
   * what stops the page offering a link that answers 404.
   */
  doc: string | null;
  label: string;
  routes: string[];
  severity: string;
  category: string;
  /**
   * Every distinct defect grouped under this root cause, worst first, with the
   * judge's own words. This used to live in a separate findings list, which
   * showed the same screenshot and the same severity next to a pointer back
   * here: two cards for one thing.
   */
  defects: { attribute: string; severity: string; title: string; problem: string }[];
  /** The screenshots this issue was filed against. */
  shots: BoardShot[];
  /**
   * The frames frozen either side of a fix.
   *
   * Empty until a `verify-fix` has run, and `after` stays empty until one
   * passed. They are not derivable from `shots`: the evidence store overwrites
   * a view in place, so by the time an issue is done its shots ARE the fixed
   * screen, and the defect only still exists in these.
   */
  before: BoardShot[];
  after: BoardShot[];
  /** When lookout last saw this, or null when it cannot tell. */
  lastSeenAt: string | null;
  status: IssueStatus;
  /** Everything lookout has recorded about it, oldest first. */
  timeline: BoardStep[];
  /**
   * What would prove this issue fixed, and where each one stands. Only lookout
   * writes these verdicts; the page renders them read-only.
   */
  acceptance: AcceptanceCriterion[];
  /** Attempts spent asking lookout to rule on a claimed fix. */
  attempt: number;
  verdict: string | null;
  judgeNote: string | null;
  /**
   * The commit this issue was fixed in, or the one a fix was last claimed at,
   * with somewhere to read it.
   *
   * `cleared` is the difference between the two, and it is not cosmetic: a
   * commit lookout ruled on is a fact, and a commit somebody reported is a
   * claim that is still open. The url is null when the repository has no
   * remote lookout could turn into a web address, which is a normal state for
   * a checkout and not an error.
   */
  fix: {
    commit: string;
    short: string;
    url: string | null;
    host: string | null;
    cleared: boolean;
    at: string | null;
  } | null;
  /**
   * Filed away, and why. `fixed` is somebody clearing a confirmed fix off the
   * board; `intentional` is the older meaning, an adjudication that the defect
   * was never one. Null while the issue is still work.
   */
  archived: { at: string; reason: "fixed" | "intentional" } | null;
}

/** Screenshots an issue was filed against, newest per member, both path forms. */
