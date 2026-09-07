/**
 * The issues waiting to be handed over, in the order somebody asked for them.
 *
 * Pressing play on a card used to open a Terminal there and then, and pressing
 * it on five cards opened five of them into one working tree. What a reader
 * actually means by that press is "this one next", so the press writes the
 * issue down here and one is handed over at a time.
 *
 * Stored in the project it belongs to, `<project>/.lookout/queue.json`, beside
 * `ui.json`. It holds six-digit issue ids, which mean nothing outside that
 * project's backlog, so it cannot live anywhere else.
 *
 * The file is authoritative because more than one Lookout process can update
 * a project. A running server keeps the current project's queue in memory only
 * as a response cache.
 */
import { mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOOKOUT_DIR } from "../config-locate.js";
import { TOOLS } from "../report/handoff.js";
import { atomicWriteJson } from "../state/atomic.js";
import { withProjectDirStateLock } from "../state/lock.js";

/** One issue waiting its turn, and what has been done about it so far. */
export interface QueueItem {
  /** The six-digit issue id. */
  issue: string;
  /**
   * Which coding tools work it, in the order they take their turns, chosen when
   * it was queued.
   *
   * A list rather than one name because the picker is a selector: naming two
   * says they consult, and consulting is turns rather than a committee. The
   * first drafts, the second reviews what it finds and revises, and so on round
   * the list for as many turns as the issue's attempts allow.
   */
  tools: string[];
  /**
   * Whose turn is next, as an index into `tools` modulo its length.
   *
   * Absent means the first. It advances only when an attempt has actually been
   * spent, which is the same evidence a second handoff already waited for, so a
   * queue watching an unchanged board never rotates.
   */
  turn?: number;
  queuedAt: string;
  /**
   * When a Terminal was actually opened for it.
   *
   * Absent means it is still waiting; present means the handoff happened and
   * what the queue is waiting for now is lookout's own ruling.
   */
  handedOffAt?: string;
  /**
   * The issue's spent-attempt count at the moment it was handed off.
   *
   * This is what makes a second handoff safe: one only happens once
   * `verify-fix` has actually charged an attempt and come back still-open, so
   * a queue watching an unchanged board never opens a second window.
   */
  handedOffAtAttempt?: number;
  /** Durable claim written before an external handoff is invoked. */
  dispatching?: { token: string; pid: number; at: string };
  /**
   * When a handoff was attempted and could not happen, and why.
   *
   * Terminal until somebody acts on it. Without it the head would match the
   * "not handed off yet" case again on the next tick, and since saving the
   * reason is itself a write into a watched directory, that is an unbounded
   * loop rather than a retry.
   */
  failedAt?: string;
  lastReason?: string;
}

/**
 * The tools a press asked for, as a list the queue can hold.
 *
 * The page sends what its selector has on; this decides what that means. An
 * unknown key is dropped rather than refused, because a page from a newer
 * build naming a tool this server has never heard of should still queue the
 * issue with the ones it does know. Nothing selected, or nothing recognised,
 * falls back to the one tool every install has a mark for, which is what the
 * older single-choice payload always meant.
 */
export function queuedTools(body: { tool?: string; tools?: unknown }): string[] {
  const asked = toolList({ tool: body.tool, tools: body.tools });
  const known = asked.filter((t) => t in TOOLS);
  return known.length ? known : ["claude-code"];
}

export function queuePath(projectDir: string): string {
  return join(projectDir, LOOKOUT_DIR, "queue.json");
}

/** The file's mtime, or 0 when there is no file. What a reload is decided on. */
export function queueMtime(projectDir: string): number {
  try {
    return statSync(queuePath(projectDir)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The tools on a record, in either spelling.
 *
 * A queue written before the picker became a selector names one `tool`, and
 * that file is sitting in projects right now. Reading both here rather than
 * migrating the file means an old queue keeps working and a downgrade does not
 * strand it: the first tool of a list is exactly what the older reader wants.
 */
function toolList(r: Record<string, unknown>): string[] {
  const raw = Array.isArray(r.tools) ? r.tools : typeof r.tool === "string" ? [r.tool] : [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string" || !t.trim()) continue;
    if (!out.includes(t.trim())) out.push(t.trim());
  }
  return out;
}

function one(raw: unknown): QueueItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // The id and at least one tool are what nothing works without; the rest of
  // the record is progress, and a missing one just means "not yet".
  if (typeof r.issue !== "string" || !r.issue.trim()) return null;
  const tools = toolList(r);
  if (!tools.length) return null;
  const item: QueueItem = {
    issue: r.issue.trim(),
    tools,
    queuedAt: typeof r.queuedAt === "string" ? r.queuedAt : new Date(0).toISOString(),
  };
  if (typeof r.turn === "number" && Number.isInteger(r.turn) && r.turn >= 0) item.turn = r.turn;
  if (typeof r.handedOffAt === "string") item.handedOffAt = r.handedOffAt;
  if (typeof r.handedOffAtAttempt === "number") item.handedOffAtAttempt = r.handedOffAtAttempt;
  if (
    typeof r.dispatching === "object" && r.dispatching !== null &&
    typeof (r.dispatching as Record<string, unknown>).token === "string" &&
    typeof (r.dispatching as Record<string, unknown>).pid === "number" &&
    typeof (r.dispatching as Record<string, unknown>).at === "string"
  ) {
    item.dispatching = r.dispatching as QueueItem["dispatching"];
  }
  if (typeof r.failedAt === "string") item.failedAt = r.failedAt;
  if (typeof r.lastReason === "string") item.lastReason = r.lastReason;
  return item;
}

export async function loadQueue(projectDir: string): Promise<QueueItem[]> {
  const p = queuePath(projectDir);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as unknown;
    const items = Array.isArray(raw) ? raw : (raw as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    // One unreadable entry costs that entry, not the queue: the rest of the
    // list is still what somebody asked for.
    const out: QueueItem[] = [];
    const seen = new Set<string>();
    for (const entry of items) {
      const item = one(entry);
      if (!item || seen.has(item.issue)) continue;
      seen.add(item.issue);
      out.push(item);
    }
    return out;
  } catch {
    // A queue nobody can parse is not worth refusing to start over. An empty
    // one is the honest reading of a file that says nothing.
    return [];
  }
}

export async function saveQueue(projectDir: string, items: QueueItem[]): Promise<void> {
  await withProjectDirStateLock(projectDir, "queue", async () => saveQueueLocked(projectDir, items));
}

async function saveQueueLocked(projectDir: string, items: QueueItem[]): Promise<void> {
  const p = queuePath(projectDir);
  await mkdir(join(projectDir, LOOKOUT_DIR), { recursive: true });
  await atomicWriteJson(p, { items });
}

/** Apply one queue intent to the latest on-disk value. */
export async function updateQueue<T>(
  projectDir: string,
  mutate: (items: QueueItem[]) => T | Promise<T>,
  opts: { initial?: readonly QueueItem[]; save?: (result: T) => boolean } = {},
): Promise<{ items: QueueItem[]; result: T }> {
  return withProjectDirStateLock(projectDir, "queue", async () => {
    const items = existsSync(queuePath(projectDir))
      ? await loadQueue(projectDir)
      : opts.initial?.map((item) => ({ ...item, tools: [...item.tools] })) ?? [];
    const result = await mutate(items);
    if (opts.save?.(result) ?? true) await saveQueueLocked(projectDir, items);
    return { items, result };
  });
}

/** What is written to disk, for deciding whether writing is worth doing. */
export function queueDigest(items: QueueItem[]): string {
  return JSON.stringify(items);
}
