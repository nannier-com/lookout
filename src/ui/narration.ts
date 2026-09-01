/**
 * The judge's own words, on their way to the page.
 *
 * The board is pushed whole because it is small and because the page redraws
 * only what moved. Narration cannot work that way: a judge writing a verdict
 * produces lines several times a second, and re-sending the tail each time
 * would put the same thousand lines on the wire over and over. So this keeps a
 * cursor and sends only what is new, which is also what lets the page append
 * rather than repaint.
 *
 * The file it reads is discarded and rewritten by the run that owns it, and
 * trimmed from the front once it grows. Both of those make the cursor wrong in
 * the same way and are noticed the same way: the file got shorter than what has
 * already been read. The page is told to clear and given the tail as it stands,
 * which is the honest answer to "I have lost track of where you were".
 */
import { existsSync, readFileSync } from "node:fs";
import { narrationPath, type NarrationLine } from "../report/narration.js";

// Re-exported because the page reads these off the frame and cannot import from
// outside `client/`; a type import of this module is erased at compile time.
export type { NarrationLine };
import type { ResolvedConfig } from "../types.js";

/** What the page is sent: lines to append, or a clear plus the tail. */
export interface NarrationFrame {
  /** True when the page should throw away what it has: a new run, or a trim. */
  reset: boolean;
  lines: NarrationLine[];
}

/**
 * The most lines to hand a page at once.
 *
 * Only reached on a reset, when the whole tail goes down together. A page that
 * has been open all along receives a handful of lines at a time.
 */
const MAX_LINES = 400;

let cursor = 0;
let readingPath = "";

/** Forget where we were: a different project's narration is a different file. */
export function forgetNarration(): void {
  cursor = 0;
  readingPath = "";
}

/**
 * What has been said since the last time this was asked, or null for nothing.
 *
 * Null rather than an empty frame so the caller can skip the send entirely: a
 * board sitting idle should cost no traffic, and the watcher fires on every
 * file a capture writes.
 */
export function newNarration(resolved: ResolvedConfig): NarrationFrame | null {
  const path = narrationPath(resolved);
  if (path !== readingPath) {
    readingPath = path;
    cursor = 0;
  }
  if (!existsSync(path)) {
    // A project with nothing captured yet, or a run that cleared it. Only worth
    // saying once, which is what a cursor already at zero means.
    if (cursor === 0) return null;
    cursor = 0;
    return { reset: true, lines: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // Shorter than what has been read means the run replaced or trimmed it, and
  // the cursor now points into the middle of somebody else's sentence.
  const reset = raw.length < cursor;
  if (reset) cursor = 0;
  const fresh = raw.slice(cursor);
  // Only whole lines: the last one may still be being written.
  const end = fresh.lastIndexOf("\n");
  if (end === -1) return reset ? { reset, lines: [] } : null;
  cursor += end + 1;
  const lines = parse(fresh.slice(0, end));
  if (lines.length === 0 && !reset) return null;
  return { reset, lines: lines.slice(-MAX_LINES) };
}

function parse(block: string): NarrationLine[] {
  const out: NarrationLine[] = [];
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NarrationLine);
    } catch {
      // A line the writer was midway through when the file was read. It is
      // whole in the file by now, but the cursor has passed it: one lost line
      // of narration is not worth a second read of the whole file.
    }
  }
  return out;
}
