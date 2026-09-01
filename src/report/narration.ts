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
 *
 * Coalescing is per CALL, never per judge. A check runs two workers over view
 * groups, and both walk their panels in the same order, so at any moment two
 * calls to the SAME judge are usually in flight against different views.
 * Buffering by name spliced their two verdicts into one stream of prose, which
 * is not untidy but wrong: the reassembled text carried two JSON replies
 * shredded together under one heading, with nothing to say which view either
 * half belonged to. Every line therefore carries the id of the call that said
 * it, and each call gathers its prose in its own buffer.
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
  /**
   * Which call of that judge said it.
   *
   * The name alone does not identify a speaker: two workers judge two view
   * groups at once and reach the same panel at the same time. This is what
   * keeps their prose apart, in the file and on the page.
   */
  call: string;
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

/** One call's prose, waiting for enough of it to be worth a line. */
interface Gathering {
  panel: string;
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
}

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
  /** One gathering buffer per call in flight, because several are. */
  private readonly open = new Map<string, Gathering>();
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

  /** Everything one judge call says, tagged with which call is saying it. */
  say(call: string, panel: string, s: JudgeSay): void {
    if (!this.enabled) return;
    if (s.kind === "tool") {
      // A tool call is a landmark in this call's stream, so it goes down whole
      // and in its place: the prose either side of it belongs either side of it.
      this.flush(call);
      this.write(call, panel, "tool", s.text);
      return;
    }
    const g = this.gathering(call, panel);
    g.text += s.text;
    if (g.text.length >= COALESCE_CHARS) {
      this.flush(call);
      return;
    }
    g.timer ??= setTimeout(() => this.flush(call), COALESCE_MS);
    // Nothing should be kept alive waiting to say something.
    g.timer.unref?.();
  }

  /**
   * Bracket one call, which is what the page counts progress in.
   *
   * A close also forgets the call's buffer, so a run that judges hundreds of
   * groups does not accumulate one entry per call for its whole life.
   */
  mark(call: string, panel: string, kind: "open" | "close", text: string): void {
    if (!this.enabled) return;
    this.flush(call);
    this.write(call, panel, kind, text);
    if (kind === "close") this.open.delete(call);
  }

  /**
   * Write out prose being gathered: one call's, or every call's.
   *
   * The whole-file form is for the end of a run, where a call that never closed
   * still has something worth saying.
   */
  flush(call?: string): void {
    for (const [id, g] of call === undefined ? [...this.open] : [[call, this.open.get(call)] as const]) {
      if (!g) continue;
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
      const text = g.text;
      g.text = "";
      if (text) this.write(id, g.panel, "text", text);
    }
  }

  /** The buffer for one call, made on first use. */
  private gathering(call: string, panel: string): Gathering {
    let g = this.open.get(call);
    if (!g) {
      g = { panel, text: "", timer: null };
      this.open.set(call, g);
    }
    return g;
  }

  private write(call: string, panel: string, kind: NarrationLine["kind"], text: string): void {
    if (!this.enabled) return;
    const line: NarrationLine = { at: new Date().toISOString(), runId: this.runId, panel, call, kind, text };
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
export function say(call: string, panel: string, s: JudgeSay): void {
  current?.say(call, panel, s);
}

/**
 * Begin one judge call, and get back the id everything it says is tagged with.
 *
 * Minted here rather than derived from the panel and the view because the
 * caller that needs it least should not have to construct it: a counter is
 * unique by definition, and a retry of the same panel over the same shots is
 * genuinely a second call rather than a continuation of the first.
 */
let calls = 0;
export function openCall(panel: string, text: string): string {
  const call = `c${++calls}`;
  current?.mark(call, panel, "open", text);
  return call;
}

/** End one judge call, releasing its buffer. */
export function closeCall(call: string, panel: string): void {
  current?.mark(call, panel, "close", "");
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
