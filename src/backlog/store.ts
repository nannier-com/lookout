/** The backlog's authoritative JSON and its generated projections. */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadReport } from "../capture/store.js";
import { lookoutDir } from "../config.js";
import { reconcileIssues } from "../issues/registry.js";
import { materializeIssues } from "../issues/store.js";
import { atomicWriteFile, atomicWriteJson } from "../state/atomic.js";
import { withProjectLock, withStateLock } from "../state/lock.js";
import type { ResolvedConfig } from "../types.js";
import { nowIso } from "../util.js";
import { emptyBacklog, normalizeBacklog, renderMarkdown, type Backlog } from "./lib.js";
import { migrateBacklogRouteIdentity } from "./route-migration.js";

export function backlogPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "backlog.json");
}

export function markdownPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "BACKLOG.md");
}

export function backlogPendingPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "backlog.pending.json");
}

async function readBacklog(resolved: ResolvedConfig): Promise<Backlog> {
  const path = backlogPath(resolved);
  if (!existsSync(path)) return emptyBacklog(resolved.project, nowIso());
  return normalizeBacklog(JSON.parse(await readFile(path, "utf8")) as Backlog);
}

async function loadBacklogLocked(resolved: ResolvedConfig): Promise<Backlog> {
  if (existsSync(backlogPendingPath(resolved))) {
    const authority = await readBacklog(resolved);
    await materializeIssues(resolved, authority);
    await atomicWriteFile(markdownPath(resolved), renderMarkdown(authority));
    await rm(backlogPendingPath(resolved), { force: true });
  }
  const backlog = await readBacklog(resolved);
  const beforeReconcile = JSON.stringify(backlog);
  const migrated = await migrateBacklogRouteIdentity(resolved, backlog, await loadReport(resolved));
  reconcileIssues(backlog, nowIso());
  if (migrated || JSON.stringify(backlog) !== beforeReconcile) await saveBacklogLocked(resolved, backlog);
  return backlog;
}

export async function loadBacklog(resolved: ResolvedConfig): Promise<Backlog> {
  const candidate = await readBacklog(resolved);
  const repaired = structuredClone(candidate);
  reconcileIssues(repaired, nowIso());
  if (
    repaired.routeIdentity === 2
    && JSON.stringify(repaired) === JSON.stringify(candidate)
    && !existsSync(backlogPendingPath(resolved))
  ) return repaired;

  return withProjectLock(resolved, "backlog repair", async () =>
    withStateLock(resolved, "backlog", async () => loadBacklogLocked(resolved)));
}

async function saveBacklogLocked(resolved: ResolvedConfig, backlog: Backlog): Promise<void> {
  reconcileIssues(backlog, nowIso());
  await atomicWriteJson(backlogPendingPath(resolved), {
    schema: 1,
    startedAt: nowIso(),
  });
  // Commit the authority before deriving anything from it. The pending marker
  // makes projections replayable if the process stops after this replacement.
  await atomicWriteJson(backlogPath(resolved), backlog);
  await materializeIssues(resolved, backlog);
  await atomicWriteFile(markdownPath(resolved), renderMarkdown(backlog));
  await rm(backlogPendingPath(resolved), { force: true });
}

export async function saveBacklog(resolved: ResolvedConfig, backlog: Backlog): Promise<void> {
  await withProjectLock(resolved, "backlog save", async () =>
    withStateLock(resolved, "backlog", async () => saveBacklogLocked(resolved, backlog)));
}

export async function updateBacklog<T>(
  resolved: ResolvedConfig,
  mutate: (backlog: Backlog) => T | Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<{ backlog: Backlog; result: T }> {
  return withProjectLock(resolved, "backlog update", async () =>
    withStateLock(resolved, "backlog", async () => {
      const backlog = await loadBacklogLocked(resolved);
      const result = await mutate(backlog);
      await saveBacklogLocked(resolved, backlog);
      return { backlog, result };
    }), opts);
}
