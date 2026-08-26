/**
 * The run event log, and the board it folds into.
 *
 * A `check --auto` run takes minutes, and until it exits, both the user and the
 * agent that started it are blind: a subprocess's stdout arrives all at once at
 * the end. So lookout narrates to disk as it goes. Everything that happens
 * appends one JSON line to `.lookout/evidence/events.jsonl`, which `lookout
 * status` reads for a session and `lookout ui` renders for a person, both while
 * the run is still going.
 *
 * One log spans several processes. `check --auto` defines the board: it names
 * the clusters and truncates whatever the previous board left behind. Every run
 * that reports back on that board afterwards, `verify-fix` and `agent`, joins
 * the same file instead of starting a new one. That is what lets a card show a
 * cluster dispatched by one process, worked by a subagent in another, and ruled
 * on by a third.
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
  | "agent-start"
  | "agent-note"
  | "agent-done"
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
  "dispatch",
  "agent-start",
  "agent-note",
  "agent-done",
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
   * A `verify-fix` that truncated here would erase the dispatches it is ruling
   * on, and the board would lose every cluster but the one in hand.
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

// ---------------------------------------------------------------------------
// The board: one row per dispatched cluster, and where its fix session got to.

/**
 * Where a cluster stands. `queued` means lookout dispatched work nobody has
 * picked up yet; the states after it exist only because the session driving the
 * run reports them, so a harness that never reports leaves a card at `queued`
 * rather than lying about it.
 */
export type AgentStatus =
  | "queued"
  | "working"
  | "reported"
  | "verifying"
  | "passed"
  | "still-open"
  | "regressed"
  | "blocked";

/** A screenshot, as the board needs it: enough to render a tile and a caption. */
export interface BoardShot {
  path: string;
  route: string;
  formFactor: string;
  scheme: string;
  state?: string;
}

export interface BoardAgent {
  name: string;
  startedAt: string;
  /** Last time this session said anything; how the UI tells slow from stalled. */
  lastSeenAt: string;
  finishedAt: string | null;
  commit: string | null;
  note: string | null;
  notes: { at: string; text: string }[];
}

export interface BoardEntry {
  id: string;
  label: string;
  brief: string;
  /** The cluster's own contact sheet, when one was composited. */
  sheet: string | null;
  routes: string[];
  severity: string;
  category: string;
  /** What the defect looked like when it was found. */
  shots: BoardShot[];
  /** What the most recent `verify-fix` saw, after a fix was claimed. */
  recheck: BoardShot[];
  dispatchedAt: string;
  amended: boolean;
  status: AgentStatus;
  agent: BoardAgent | null;
  attempt: number;
  verdict: string | null;
  judgeNote: string | null;
}

export interface RunStatus {
  runId: string | null;
  /** The run that defined the board, which later runs report against. */
  boardRunId: string | null;
  phase: string;
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
  shots: number;
  findings: { critical: number; high: number; medium: number; low: number; total: number };
  batches: { done: number; total: number };
  board: BoardEntry[];
  /** Counts by board status, so a caller can render a summary without folding. */
  agents: { queued: number; working: number; reported: number; resolved: number };
  dispatched: { id: string; label: string; brief: string; routes: string[] }[];
  verdicts: { cluster: string; verdict: string; attempt: number }[];
  errors: string[];
  lastMessage: string;
}

function shotOf(data: Record<string, unknown> | undefined): BoardShot | null {
  const path = typeof data?.path === "string" ? data.path : null;
  if (!path) return null;
  return {
    path,
    route: String(data?.route ?? ""),
    formFactor: String(data?.formFactor ?? ""),
    scheme: String(data?.scheme ?? ""),
    ...(typeof data?.state === "string" ? { state: data.state } : {}),
  };
}

function dedupeShots(shots: BoardShot[]): BoardShot[] {
  const seen = new Set<string>();
  const out: BoardShot[] = [];
  for (const s of shots) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    out.push(s);
  }
  return out;
}

const RESOLVED: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["passed", "blocked"]);

/** Fold the log into the answer to "what is lookout doing right now". */
export function summarise(events: LookoutEvent[]): RunStatus {
  const s: RunStatus = {
    runId: null,
    boardRunId: null,
    phase: "idle",
    running: false,
    startedAt: null,
    endedAt: null,
    shots: 0,
    findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    batches: { done: 0, total: 0 },
    board: [],
    agents: { queued: 0, working: 0, reported: 0, resolved: 0 },
    dispatched: [],
    verdicts: [],
    errors: [],
    lastMessage: "",
  };

  const board = new Map<string, BoardEntry>();
  // The run currently being read. `cluster` is set for runs that report against
  // one board row, which is how a re-check's screenshots find their card.
  let run: { id: string; isBoard: boolean; cluster: string | null } = {
    id: "",
    isBoard: false,
    cluster: null,
  };

  for (const e of events) {
    s.runId = e.runId;
    s.lastMessage = e.message;
    const cid = typeof e.data?.cluster === "string" ? e.data.cluster : null;

    switch (e.kind) {
      case "run-start": {
        // The first run in the file is the one that defined the board; the
        // headline counts describe it, so a re-check of one cluster does not
        // inflate "12 shots" into "14".
        const isBoard = s.boardRunId === null;
        if (isBoard) {
          s.boardRunId = e.runId;
          s.startedAt = e.at;
        }
        run = { id: e.runId, isBoard, cluster: cid };
        s.running = true;
        s.endedAt = null;
        s.phase = isBoard ? "starting" : e.message;
        if (cid) {
          const entry = board.get(cid);
          if (entry && !RESOLVED.has(entry.status)) {
            entry.status = "verifying";
            entry.recheck = [];
          }
        }
        break;
      }
      case "phase":
        s.phase = e.message;
        break;
      case "shot": {
        if (run.isBoard) s.shots++;
        const shot = shotOf(e.data);
        // A re-check runs under a cluster's own run, so its screenshots are
        // that card's "after"; they are the freshest thing lookout has seen of
        // the thing this agent is working on.
        if (shot && run.cluster) {
          const entry = board.get(run.cluster);
          if (entry) entry.recheck = dedupeShots([...entry.recheck, shot]);
        }
        break;
      }
      case "capture-done":
        if (run.isBoard) s.phase = "captured";
        break;
      case "judge-start":
        s.phase = "judging";
        if (run.isBoard) s.batches.total = Number(e.data?.batches ?? 0);
        break;
      case "batch":
        if (run.isBoard) s.batches.done++;
        break;
      case "finding": {
        if (!run.isBoard) break;
        const sev = (e.data?.severity as keyof RunStatus["findings"]) ?? "low";
        if (sev in s.findings) s.findings[sev]++;
        s.findings.total++;
        break;
      }
      case "dispatch": {
        const id = String(e.data?.id ?? "");
        if (!id) break;
        const shots = dedupeShots(
          ((e.data?.shots as Record<string, unknown>[] | undefined) ?? [])
            .map(shotOf)
            .filter((v): v is BoardShot => v !== null),
        );
        const prior = board.get(id);
        // A dispatch is work nobody has picked up, including an amendment that
        // supersedes a session already running on a narrower brief.
        board.set(id, {
          id,
          label: String(e.data?.label ?? id),
          brief: String(e.data?.brief ?? ""),
          sheet: typeof e.data?.sheet === "string" ? e.data.sheet : null,
          routes: (e.data?.routes as string[]) ?? [],
          severity: String(e.data?.severity ?? ""),
          category: String(e.data?.category ?? ""),
          shots: shots.length > 0 ? shots : (prior?.shots ?? []),
          recheck: prior?.recheck ?? [],
          dispatchedAt: e.at,
          amended: e.data?.amended === true,
          status: "queued",
          agent: null,
          attempt: prior?.attempt ?? 0,
          verdict: null,
          judgeNote: null,
        });
        break;
      }
      case "agent-start": {
        const entry = cid ? board.get(cid) : undefined;
        if (!entry) break;
        entry.status = "working";
        entry.agent = {
          name: String(e.data?.name ?? entry.label),
          startedAt: e.at,
          lastSeenAt: e.at,
          finishedAt: null,
          commit: null,
          note: null,
          notes: [],
        };
        break;
      }
      case "agent-note": {
        const entry = cid ? board.get(cid) : undefined;
        if (!entry?.agent) break;
        entry.agent.lastSeenAt = e.at;
        entry.agent.notes.push({ at: e.at, text: e.message });
        break;
      }
      case "agent-done": {
        const entry = cid ? board.get(cid) : undefined;
        if (!entry) break;
        const name = String(e.data?.name ?? entry.agent?.name ?? entry.label);
        entry.status = "reported";
        entry.agent = {
          name,
          startedAt: entry.agent?.startedAt ?? e.at,
          lastSeenAt: e.at,
          finishedAt: e.at,
          commit: typeof e.data?.commit === "string" ? e.data.commit : null,
          note: typeof e.data?.note === "string" ? e.data.note : null,
          notes: entry.agent?.notes ?? [],
        };
        break;
      }
      case "verdict": {
        const verdict = String(e.data?.verdict ?? "");
        s.verdicts.push({
          cluster: String(e.data?.cluster ?? ""),
          verdict,
          attempt: Number(e.data?.attempt ?? 0),
        });
        const entry = cid ? board.get(cid) : undefined;
        if (!entry) break;
        entry.verdict = verdict;
        entry.attempt = Number(e.data?.attempt ?? entry.attempt);
        entry.judgeNote = typeof e.data?.judgeNote === "string" ? e.data.judgeNote : null;
        if (
          verdict === "passed" ||
          verdict === "still-open" ||
          verdict === "regressed" ||
          verdict === "blocked"
        ) {
          entry.status = verdict;
        }
        break;
      }
      case "error":
        s.errors.push(e.message);
        break;
      case "run-end":
        s.endedAt = e.at;
        s.running = false;
        s.phase = run.isBoard ? "done" : s.phase;
        break;
    }
  }

  // Worst first, and within a status the oldest dispatch first, so a board read
  // top to bottom is "what needs a session now" before "what is already ruled".
  const ORDER: Record<AgentStatus, number> = {
    working: 0,
    reported: 1,
    verifying: 2,
    regressed: 3,
    "still-open": 4,
    queued: 5,
    blocked: 6,
    passed: 7,
  };
  s.board = [...board.values()].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.dispatchedAt.localeCompare(b.dispatchedAt),
  );

  for (const e of s.board) {
    if (e.status === "working" || e.status === "verifying") s.agents.working++;
    else if (e.status === "reported") s.agents.reported++;
    else if (RESOLVED.has(e.status)) s.agents.resolved++;
    else s.agents.queued++;
  }

  // Kept for callers that only ever needed the flat pair.
  s.dispatched = s.board.map((e) => ({
    id: e.id,
    label: e.label,
    brief: e.brief,
    routes: e.routes,
  }));

  return s;
}
