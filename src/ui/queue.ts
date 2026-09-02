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
 * The list a running server holds is the authority and this file is its
 * sidecar, with one exception: the mtime is remembered, so a second `lookout
 * ui` on the same project (restarting one is routine) is noticed rather than
 * silently overwritten.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOOKOUT_DIR } from "../config-locate.js";

/** One issue waiting its turn, and what has been done about it so far. */
export interface QueueItem {
  /** The six-digit issue id. */
  issue: string;
  /** Which coding tool to hand it to, chosen when it was queued. */
  tool: string;
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

function one(raw: unknown): QueueItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // The id and the tool are the two fields nothing works without; the rest of
  // the record is progress, and a missing one just means "not yet".
  if (typeof r.issue !== "string" || !r.issue.trim()) return null;
  if (typeof r.tool !== "string" || !r.tool.trim()) return null;
  const item: QueueItem = {
    issue: r.issue.trim(),
    tool: r.tool.trim(),
    queuedAt: typeof r.queuedAt === "string" ? r.queuedAt : new Date(0).toISOString(),
  };
  if (typeof r.handedOffAt === "string") item.handedOffAt = r.handedOffAt;
  if (typeof r.handedOffAtAttempt === "number") item.handedOffAtAttempt = r.handedOffAtAttempt;
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
  const p = queuePath(projectDir);
  await mkdir(join(projectDir, LOOKOUT_DIR), { recursive: true });
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify({ items }, null, 2) + "\n");
  await rename(tmp, p);
}

/** What is written to disk, for deciding whether writing is worth doing. */
export function queueDigest(items: QueueItem[]): string {
  return JSON.stringify(items);
}
