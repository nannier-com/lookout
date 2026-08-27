/**
 * The run event log, and the board it folds into.
 *
 * A `check` run takes minutes, and until it exits, both the user and the
 * agent that started it are blind: a subprocess's stdout arrives all at once at
 * the end. So lookout narrates to disk as it goes. Everything that happens
 * appends one JSON line to `.lookout/evidence/events.jsonl`, which `lookout
 * status` reads for a session and `lookout ui` renders for a person, both while
 * the run is still going.
 *
 * One log spans several processes. `check` and `capture` define the board:
 * they truncate whatever the previous run left behind. A `verify-fix` ruling
 * on those findings afterwards joins the same file instead of starting a new
 * one. That is what lets an issue's card show a defect found by one run and
 * ruled on by another.
 *
 * Writing is best-effort and synchronous-append: an unwritable log must never
 * take down a capture, and the appends are small enough that ordering under
 * concurrent batches is preserved by the filesystem.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evidenceDir } from "../config.js";
import type { ResolvedConfig, Severity } from "../types.js";

export type EventKind =
  | "run-start"
  | "phase"
  | "target"
  | "shot"
  | "capture-done"
  | "judge-start"
  | "batch"
  | "finding"
  | "verdict"
  | "note"
  | "error"
  | "run-end";

/**
 * Kinds the board is reconstructed from. Everything else is narration: useful
 * to read, safe to drop when the log is pruned.
 */
const STRUCTURAL: ReadonlySet<EventKind> = new Set<EventKind>([
  "run-start",
  "shot",
  "finding",
  "verdict",
  "run-end",
]);

/**
 * The UI re-reads and re-parses the whole log every poll, so an append-only
 * file that spans a long fix session has to stay small. Past this many lines,
 * joining runs drop the oldest narration and keep every structural event.
 */
const MAX_EVENTS = 4000;
const KEEP_NARRATION = 400;

export interface LookoutEvent {
  at: string;
  runId: string;
  kind: EventKind;
  /** One-line human/agent readable summary. */
  message: string;
  /** Kind-specific payload; the UI reads what it recognises and ignores the rest. */
  data?: Record<string, unknown>;
  severity?: Severity | "error" | "info";
}

export function eventsPath(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "events.jsonl");
}

export class EventLog {
  private readonly path: string;
  private readonly runId: string;
  private enabled = true;

  constructor(resolved: ResolvedConfig, runId: string) {
    this.path = eventsPath(resolved);
    this.runId = runId;
  }

  /**
   * Begin a board: a run that decides what the clusters are, discarding the
   * previous board's narration. Only `check` and `capture` do this.
   */
  start(message: string, data?: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, "");
    } catch {
      this.enabled = false;
      return;
    }
    this.emit("run-start", message, data);
  }

  /**
   * Report against the board a previous run defined, keeping its narration.
   * A `verify-fix` that truncated here would erase the narration of the run it
   * is ruling on, and the board's live overlay would lose every issue but the
   * one in hand.
   */
  join(message: string, data?: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (!existsSync(this.path)) writeFileSync(this.path, "");
      else prune(this.path);
    } catch {
      this.enabled = false;
      return;
    }
    this.emit("run-start", message, data);
  }

  emit(kind: EventKind, message: string, data?: Record<string, unknown>, severity?: LookoutEvent["severity"]): void {
    if (!this.enabled) return;
    const ev: LookoutEvent = {
      at: new Date().toISOString(),
      runId: this.runId,
      kind,
      message,
      ...(data ? { data } : {}),
      ...(severity ? { severity } : {}),
    };
    try {
      appendFileSync(this.path, `${JSON.stringify(ev)}\n`);
    } catch {
      this.enabled = false;
    }
  }
}

/** Drop the oldest narration once the log grows past its cap, keeping the board. */
function prune(path: string): void {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length <= MAX_EVENTS) return;
  const kept: string[] = [];
  const narration: string[] = [];
  for (const line of lines) {
    let kind: string;
    try {
      kind = (JSON.parse(line) as LookoutEvent).kind;
    } catch {
      continue;
    }
    if (STRUCTURAL.has(kind as EventKind)) kept.push(line);
    else narration.push(line);
  }
  // Structural events keep their order relative to each other, which is all the
  // fold needs; interleaved narration is only ever read as a tail.
  writeFileSync(path, [...kept, ...narration.slice(-KEEP_NARRATION)].join("\n") + "\n");
}

// The process-wide log for the run in flight. A CLI runs exactly one, and
// threading an instance through every capture and judge call would add a
// parameter to a dozen signatures for no gain.
let current: EventLog | null = null;

export function setCurrentLog(l: EventLog | null): void {
  current = l;
}

/** Narrate, if a run is in flight. A no-op otherwise, so callers need no guard. */
export function emit(
  kind: EventKind,
  message: string,
  data?: Record<string, unknown>,
  severity?: LookoutEvent["severity"],
): void {
  current?.emit(kind, message, data, severity);
}

/** Read a run's narration back. Tolerates a half-written trailing line. */
export function readEvents(resolved: ResolvedConfig): LookoutEvent[] {
  const p = eventsPath(resolved);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: LookoutEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LookoutEvent);
    } catch {
      // A run still in flight can leave the last line partial; skip it.
    }
  }
  return out;
}

export interface RunStatus {
  runId: string | null;
  phase: string;
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * When the run last said anything. A process that dies without emitting
   * `run-end` leaves `running` true forever, and lookout cannot see that it
   * died; callers compare this against the clock to tell live from abandoned.
   */
  lastEventAt: string | null;
  shots: number;
  findings: { critical: number; high: number; medium: number; low: number; total: number };
  batches: { done: number; total: number };
  errors: string[];
  lastMessage: string;
}

/**
 * Fold the log into the answer to "what is lookout doing right now".
 *
 * Only that. What issues exist is a question for the backlog, which outlives
 * any run; this describes the run in flight and nothing else.
 */
export function summarise(events: LookoutEvent[]): RunStatus {
  const s: RunStatus = {
    runId: null,
    phase: "idle",
    running: false,
    startedAt: null,
    endedAt: null,
    lastEventAt: null,
    shots: 0,
    findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    batches: { done: 0, total: 0 },
    errors: [],
    lastMessage: "",
  };

  let isBoardRun = false;
  let seenFirstRun = false;

  for (const e of events) {
    s.runId = e.runId;
    s.lastEventAt = e.at;
    s.lastMessage = e.message;

    switch (e.kind) {
      case "run-start": {
        // The first run in the file is the capture that produced the evidence;
        // the headline counts describe it, so a re-check of one issue does not
        // inflate "12 shots" into "14".
        isBoardRun = !seenFirstRun;
        if (isBoardRun) {
          seenFirstRun = true;
          s.startedAt = e.at;
          s.phase = "starting";
        } else if (typeof e.data?.issue === "string" && e.data.verb === "verify-fix") {
          s.phase = `re-judging ${e.data.issue}`;
        }
        s.running = true;
        s.endedAt = null;
        break;
      }
      case "phase":
        s.phase = e.message;
        break;
      case "shot":
        if (isBoardRun) s.shots++;
        break;
      case "capture-done":
        if (isBoardRun) s.phase = "captured";
        break;
      case "judge-start":
        s.phase = "judging";
        if (isBoardRun) s.batches.total = Number(e.data?.batches ?? 0);
        break;
      case "batch":
        if (isBoardRun) s.batches.done++;
        break;
      case "finding": {
        if (!isBoardRun) break;
        const sev = (e.data?.severity as keyof RunStatus["findings"]) ?? "low";
        if (sev in s.findings) s.findings[sev]++;
        s.findings.total++;
        break;
      }
      case "error":
        s.errors.push(e.message);
        break;
      case "run-end":
        s.endedAt = e.at;
        s.running = false;
        if (isBoardRun) s.phase = "done";
        break;
    }
  }
  return s;
}
