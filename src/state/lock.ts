/** Cross-process leases for project state and its independent resources. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { lookoutDir } from "../config.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { LOOKOUT_DIR } from "../config-locate.js";

export const LOCK_STALE_MS = 30_000;
export const LEGACY_LOCK_STALE_MS = 30 * 60_000;
const LOCK_UPDATE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;

export type LockName = "project" | "improve" | "backlog" | "report" | "design" | "attempts" | "ledger" | "navigation" | "map" | "queue" | "settings";

const ORDER: Record<LockName, number> = {
  project: 10,
  improve: 15,
  backlog: 20,
  report: 30,
  design: 35,
  ledger: 40,
  navigation: 50,
  map: 55,
  attempts: 60,
  queue: 70,
  settings: 80,
};

interface Owner {
  token: string;
  pid: number;
  host: string;
  command: string;
  acquiredAt: string;
}

interface Context {
  held: Map<string, number>;
  order: number[];
  compromised: Error[];
}

const context = new AsyncLocalStorage<Context>();

export function locksDir(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "locks");
}

export function lockTarget(resolved: ResolvedConfig, name: LockName): string {
  if (name === "improve") return join(lookoutDir(resolved), "skills", "improve.lock");
  return join(locksDir(resolved), name);
}

function commandLabel(): string {
  return process.argv.slice(1).join(" ") || "lookout";
}

async function holder(path: string): Promise<string> {
  try {
    const owner = JSON.parse(await readFile(`${path}.owner.json`, "utf8")) as Partial<Owner>;
    const who = owner.pid ? `pid ${owner.pid}` : "another process";
    const command = owner.command ? ` (${owner.command})` : "";
    return `${who}${command}`;
  } catch {
    return "another process";
  }
}

async function acquire(
  path: string,
  name: LockName,
  command: string,
  timeoutMs: number,
  compromised: Error[],
): Promise<() => Promise<void>> {
  await mkdir(join(path, ".."), { recursive: true });
  try {
    const legacy = await lstat(path);
    if (!legacy.isDirectory()) {
      if (Date.now() - legacy.mtimeMs < LEGACY_LOCK_STALE_MS) {
        throw new LookoutError(
          `project state is busy: ${name} is held by another process`,
          "wait for that lookout command to finish, then retry",
        );
      }
      await rm(path, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const started = Date.now();
  let release: (() => Promise<void>) | undefined;
  while (!release && Date.now() - started <= timeoutMs) {
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        lockfilePath: path,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: 0,
        onCompromised(error) {
          compromised.push(error);
        },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ELOCKED" && code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 75)));
    }
  }
  if (!release) {
    throw new LookoutError(
      `project state is busy: ${name} is held by ${await holder(path)}`,
      "wait for that lookout command to finish, then retry",
    );
  }
  const owner: Owner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    command: command || commandLabel(),
    acquiredAt: new Date().toISOString(),
  };
  const ownerPath = `${path}.owner.json`;
  await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`).catch(() => {});
  return async () => {
    try {
      const current = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<Owner>;
      if (current.token === owner.token) await rm(ownerPath, { force: true });
    } catch {
      // Metadata is diagnostic. The lease itself remains authoritative.
    }
    await release!();
  };
}

export async function withStateLock<T>(
  resolved: ResolvedConfig,
  name: LockName,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; command?: string } = {},
): Promise<T> {
  return withLockTarget(lockTarget(resolved, name), name, fn, opts);
}

export async function withProjectDirStateLock<T>(
  projectDir: string,
  name: LockName,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; command?: string } = {},
): Promise<T> {
  return withLockTarget(join(projectDir, LOOKOUT_DIR, "locks", name), name, fn, opts);
}

export async function withExternalStateLock<T>(
  path: string,
  command: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return withLockTarget(path, "project", fn, { ...opts, command });
}

async function withLockTarget<T>(
  path: string,
  name: LockName,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; command?: string },
): Promise<T> {
  const current = context.getStore();
  if (current?.held.has(path)) {
    current.held.set(path, current.held.get(path)! + 1);
    try {
      return await fn();
    } finally {
      current.held.set(path, current.held.get(path)! - 1);
    }
  }

  const order = ORDER[name];
  const highest = current?.order.at(-1);
  if (highest !== undefined && order < highest) {
    throw new LookoutError(`invalid state lock order: ${name} cannot be acquired here`);
  }

  const store = current ?? { held: new Map<string, number>(), order: [], compromised: [] };
  const release = await acquire(
    path,
    name,
    opts.command ?? `${name} state update`,
    opts.timeoutMs ?? LOCK_TIMEOUT_MS,
    store.compromised,
  );
  store.held.set(path, 1);
  store.order.push(order);
  let result: T | undefined;
  let primaryError: unknown;
  let failed = false;
  let releaseError: unknown;
  try {
    const run = async (): Promise<T> => fn();
    result = current ? await run() : await context.run(store, run);
    const compromised = store.compromised[0];
    if (compromised) {
      throw new LookoutError(`project state lock was compromised: ${compromised.message}`);
    }
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    store.order.pop();
    store.held.delete(path);
    try {
      await release();
    } catch (error) {
      releaseError = error;
    }
  }
  // Cleanup must not replace the error that explains why the lease became
  // unsafe. When cleanup is the only failure, it remains a real failure.
  if (failed) throw primaryError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

export function withProjectLock<T>(
  resolved: ResolvedConfig,
  command: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return withStateLock(resolved, "project", fn, { ...opts, command });
}

export function assertStateLocksHealthy(): void {
  const error = context.getStore()?.compromised[0];
  if (error) throw new LookoutError(`project state lock was compromised: ${error.message}`);
}

export async function projectLockAvailable(resolved: ResolvedConfig): Promise<boolean> {
  try {
    const path = lockTarget(resolved, "project");
    return !(await lockfile.check(path, { realpath: false, stale: LOCK_STALE_MS, lockfilePath: path }));
  } catch {
    return true;
  }
}

export async function stateLockHeld(resolved: ResolvedConfig, name: LockName): Promise<boolean> {
  return lockHeld(lockTarget(resolved, name));
}

export async function externalStateLockHeld(path: string): Promise<boolean> {
  return lockHeld(path);
}

async function lockHeld(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return Date.now() - info.mtimeMs < LEGACY_LOCK_STALE_MS;
    return await lockfile.check(path, { realpath: false, stale: LOCK_STALE_MS, lockfilePath: path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    return false;
  }
}
