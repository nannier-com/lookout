/**
 * The run event log.
 *
 * A `check --auto` run takes minutes, and until it exits, both the user and the
 * agent that started it are blind: a subprocess's stdout arrives all at once at
 * the end. So lookout narrates to disk as it goes. Everything that happens
 * appends one JSON line to `.lookout/evidence/events.jsonl`, which `lookout
 * status` reads for a session and `lookout ui` renders for a person, both while
 * the run is still going.
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
  | "dispatch"
  | "spawn-hint"
  | "verdict"
  | "note"
  | "error"
  | "run-end";

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

  /** Begin a run, discarding the previous run's narration. */
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
  shots: number;
  findings: { critical: number; high: number; medium: number; low: number; total: number };
  batches: { done: number; total: number };
  dispatched: { id: string; label: string; brief: string; routes: string[] }[];
  verdicts: { cluster: string; verdict: string; attempt: number }[];
  errors: string[];
  lastMessage: string;
}

/** Fold the log into the answer to "what is lookout doing right now". */
export function summarise(events: LookoutEvent[]): RunStatus {
  const s: RunStatus = {
    runId: null,
    phase: "idle",
    running: false,
    startedAt: null,
    endedAt: null,
    shots: 0,
    findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    batches: { done: 0, total: 0 },
    dispatched: [],
    verdicts: [],
    errors: [],
    lastMessage: "",
  };
  for (const e of events) {
    s.runId = e.runId;
    s.lastMessage = e.message;
    switch (e.kind) {
      case "run-start":
        s.startedAt = e.at;
        s.running = true;
        s.phase = "starting";
        break;
      case "phase":
        s.phase = e.message;
        break;
      case "shot":
        s.shots++;
        break;
      case "capture-done":
        s.phase = "captured";
        break;
      case "judge-start":
        s.phase = "judging";
        s.batches.total = Number(e.data?.batches ?? 0);
        break;
      case "batch":
        s.batches.done++;
        break;
      case "finding": {
        const sev = (e.data?.severity as keyof RunStatus["findings"]) ?? "low";
        if (sev in s.findings) s.findings[sev]++;
        s.findings.total++;
        break;
      }
      case "dispatch":
        s.dispatched.push({
          id: String(e.data?.id ?? ""),
          label: String(e.data?.label ?? ""),
          brief: String(e.data?.brief ?? ""),
          routes: (e.data?.routes as string[]) ?? [],
        });
        break;
      case "verdict":
        s.verdicts.push({
          cluster: String(e.data?.cluster ?? ""),
          verdict: String(e.data?.verdict ?? ""),
          attempt: Number(e.data?.attempt ?? 0),
        });
        break;
      case "error":
        s.errors.push(e.message);
        break;
      case "run-end":
        s.endedAt = e.at;
        s.running = false;
        s.phase = "done";
        break;
    }
  }
  return s;
}
