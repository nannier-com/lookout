/**
 * What the judge is saying, while it is saying it.
 *
 * This is deliberately not the event log. `events.jsonl` is the durable record
 * a board is rebuilt from, it is re-read and re-parsed in full on every push,
 * and it is capped precisely because it has to stay small. A judge writing a
 * verdict token by token produces thousands of lines per panel, which would
 * both swamp that file and evict the structural events the board is made of.
 *
 * So narration gets its own file beside it, with the opposite contract: it is
 * a tail, nothing is reconstructed from it, and the oldest of it is thrown away
 * without ceremony. It lives in the capture workspace rather than in memory so
 * that a run started in any terminal reaches the page, which is the same reason
 * the event log lives there.
 *
 * Text arrives faster than anything can usefully read it, so it is coalesced:
 * deltas accumulate until a sentence's worth has landed or a beat has passed,
 * and then one line is written. What reaches the page is the model's prose in
 * the order it was written, in pieces a person can follow.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evidenceDir } from "../config.js";
import type { JudgeSay } from "../judge/stream.js";
import type { ResolvedConfig } from "../types.js";

/** One thing said, as the page receives it. */
export interface NarrationLine {
  at: string;
  runId: string;
  /** Which judge said it: a panel name, `refuter`, or whatever the caller calls itself. */
  panel: string;
  /** `open` and `close` bracket one call; `text` and `tool` are what happened inside it. */
  kind: "open" | "text" | "tool" | "close";
  text: string;
}

/**
 * How much prose to gather before writing a line, and how long to wait for more.
 *
 * Small enough that the page keeps up with the model rather than lagging a
 * paragraph behind it, large enough that a verdict is not a thousand writes.
 */
const COALESCE_CHARS = 160;
const COALESCE_MS = 120;

/** The tail worth keeping. Past this the file is rewritten to its last lines. */
const MAX_LINES = 1200;
const KEEP_LINES = 800;
/** How often to bother checking the length, in lines written. */
const TRIM_EVERY = 200;

export function narrationPath(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "narration.jsonl");
}

/**
 * The narration of one run.
 *
 * Best-effort in the same way the event log is: a workspace that cannot be
 * written to must not take a run down, so a failed write disables the writer
 * and the run carries on judging in silence.
 */
export class Narration {
  private readonly path: string;
  private enabled = true;
  private buffer = "";
  private panel = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private written = 0;

  constructor(
    resolved: ResolvedConfig,
    private readonly runId: string,
  ) {
    this.path = narrationPath(resolved);
  }

  /** Begin a run's narration, discarding whatever the last one left. */
  start(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, "");
    } catch {
      this.enabled = false;
    }
  }

  /** Everything one judge call says, tagged with who is saying it. */
  say(panel: string, s: JudgeSay): void {
    if (!this.enabled) return;
    if (panel !== this.panel) this.flush();
    this.panel = panel;
    if (s.kind === "tool") {
      // A tool call is a landmark in the stream, so it goes down whole and in
      // its place: the prose either side of it belongs either side of it.
      this.flush();
      this.write("tool", s.text);
      return;
    }
    this.buffer += s.text;
    if (this.buffer.length >= COALESCE_CHARS) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), COALESCE_MS);
    // Nothing should be kept alive waiting to say something.
    this.timer.unref?.();
  }

  /** Say that a call has begun or ended, which is what the page counts progress in. */
  mark(panel: string, kind: "open" | "close", text: string): void {
    if (!this.enabled) return;
    this.flush();
    this.panel = panel;
    this.write(kind, text);
  }

  /** Write out whatever prose is being gathered. Safe to call at any time. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const text = this.buffer;
    this.buffer = "";
    if (text) this.write("text", text);
  }

  private write(kind: NarrationLine["kind"], text: string): void {
    if (!this.enabled) return;
    const line: NarrationLine = { at: new Date().toISOString(), runId: this.runId, panel: this.panel, kind, text };
    try {
      appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    } catch {
      this.enabled = false;
      return;
    }
    if (++this.written % TRIM_EVERY === 0) trim(this.path);
  }
}

/** Drop the oldest of it. Nothing is reconstructed from this file, so nothing is spared. */
function trim(path: string): void {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length <= MAX_LINES) return;
    writeFileSync(path, lines.slice(-KEEP_LINES).join("\n") + "\n");
  } catch {
    // A tail that could not be trimmed is a file that will be trimmed next time.
  }
}

// The process-wide narration for the run in flight, held the way the event log
// is and for the same reason: threading it through every judge call would add a
// parameter to a dozen signatures to say something every one of them means.
let current: Narration | null = null;

export function setCurrentNarration(n: Narration | null): void {
  current?.flush();
  current = n;
}

/**
 * Whether anything is listening.
 *
 * Asked before a call is made rather than after it has spoken, because the
 * streaming the page wants costs the CLI an order of magnitude more lines, and
 * a run nobody is watching should not pay for them.
 */
export function narrating(): boolean {
  return current !== null;
}

/** Narrate, if a run is in flight. A no-op otherwise, so callers need no guard. */
export function say(panel: string, s: JudgeSay): void {
  current?.say(panel, s);
}

/** Bracket one judge call, which is how the page knows what is running now. */
export function mark(panel: string, kind: "open" | "close", text: string): void {
  current?.mark(panel, kind, text);
}

/**
 * The tail of a run's narration.
 *
 * Read whole, because the file is capped at a size that makes reading it whole
 * the simplest correct thing, and a partial read of a file being appended to
 * would have to handle a torn last line for no gain.
 */
export function readNarration(resolved: ResolvedConfig, limit = KEEP_LINES): NarrationLine[] {
  const p = narrationPath(resolved);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: NarrationLine[] = [];
  for (const line of raw.split("\n").slice(-limit - 1)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NarrationLine);
    } catch {
      // A torn last line, which the next read will find whole.
    }
  }
  return out;
}
