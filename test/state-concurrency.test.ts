import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadReport } from "../src/capture/store.js";
import { backlogPath, backlogPendingPath, loadBacklog, markdownPath } from "../src/backlog/store.js";
import { emptyBacklog, renderMarkdown, type BacklogFinding } from "../src/backlog/lib.js";
import { loadState } from "../src/fix/state.js";
import { issueDir } from "../src/issues/paths.js";
import { reconcileIssues } from "../src/issues/registry.js";
import { atomicWriteJson } from "../src/state/atomic.js";
import {
  LEGACY_LOCK_STALE_MS,
  LOCK_STALE_MS,
  lockTarget,
  stateLockHeld,
  withStateLock,
} from "../src/state/lock.js";
import { loadQueue } from "../src/ui/queue.js";
import { handle } from "../src/ui/routes.js";
import { resetProject } from "../src/ui/reset.js";
import { setCurrentProject } from "../src/ui/session.js";
import { LookoutError, type ResolvedConfig } from "../src/types.js";
import { tmpProject } from "./tmp-project.js";

const workerScript = join(import.meta.dir, "state-concurrency-worker.ts");

async function until(ok: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for child processes");
    await Bun.sleep(5);
  }
}

async function concurrentWorkers(
  resolved: ResolvedConfig,
  action: "merge" | "queue" | "attempt" | "atomic" | "backlog",
  workers: readonly [string, string],
): Promise<void> {
  const barrier = join(resolved.projectDir, `${action}.start`);
  const children = workers.map((worker) =>
    Bun.spawn([process.execPath, workerScript], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        LOOKOUT_TEST_ACTION: action,
        LOOKOUT_TEST_BARRIER: barrier,
        LOOKOUT_TEST_PROJECT: JSON.stringify(resolved),
        LOOKOUT_TEST_WORKER: worker,
      },
      stdout: "pipe",
      stderr: "pipe",
    }));
  await until(() => workers.every((worker) => existsSync(`${barrier}.${worker}.ready`)));
  await writeFile(barrier, "start\n");
  const exits = await Promise.all(children.map((child) => child.exited));
  if (exits.some((code) => code !== 0)) {
    const diagnostics = await Promise.all(children.map(async (child) => await new Response(child.stderr).text()));
    throw new Error(`child process failed: ${diagnostics.join("\n")}`);
  }
}

describe("state locks", () => {
  test("exclude an independent caller and allow the holder to re-enter", async () => {
    const resolved = tmpProject("lookout-state-lock-");
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let nested = false;
    const first = withStateLock(resolved, "queue", async () => {
      await withStateLock(resolved, "queue", async () => { nested = true; });
      entered();
      await gate;
    });
    await held;
    await expect(withStateLock(resolved, "queue", async () => {}, { timeoutMs: 0 })).rejects.toBeInstanceOf(LookoutError);
    expect(nested).toBe(true);
    release();
    await first;
  });

  test("recovers a stale legacy file but blocks on a fresh one", async () => {
    const staleProject = tmpProject("lookout-stale-lock-");
    const stale = lockTarget(staleProject, "queue");
    await mkdir(join(stale, ".."), { recursive: true });
    await writeFile(stale, "legacy\n");
    const old = new Date(Date.now() - LEGACY_LOCK_STALE_MS - 1_000);
    await utimes(stale, old, old);
    let entered = false;
    await withStateLock(staleProject, "queue", async () => { entered = true; }, { timeoutMs: 0 });
    expect(entered).toBe(true);

    const freshProject = tmpProject("lookout-fresh-lock-");
    const fresh = lockTarget(freshProject, "queue");
    await mkdir(join(fresh, ".."), { recursive: true });
    await writeFile(fresh, "legacy\n");
    await expect(withStateLock(freshProject, "queue", async () => {}, { timeoutMs: 0 })).rejects.toBeInstanceOf(LookoutError);

    const middleProject = tmpProject("lookout-middle-lock-");
    const middle = lockTarget(middleProject, "improve");
    await mkdir(join(middle, ".."), { recursive: true });
    await writeFile(middle, "legacy\n");
    const thirtyOneSecondsAgo = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    await utimes(middle, thirtyOneSecondsAgo, thirtyOneSecondsAgo);
    expect(await stateLockHeld(middleProject, "improve")).toBe(true);
    await expect(withStateLock(middleProject, "improve", async () => {}, { timeoutMs: 0 })).rejects.toBeInstanceOf(LookoutError);
  });

  test("a compromised lease reports the compromise instead of masking it during release", async () => {
    const resolved = tmpProject("lookout-compromised-lock-");
    await expect(withStateLock(resolved, "queue", async () => {
      await rm(lockTarget(resolved, "queue"), { recursive: true });
      await Bun.sleep(5_500);
    })).rejects.toThrow(/project state lock was compromised:/);
  }, 8_000);

});

describe("cross-process state transactions", () => {
  test("concurrent capture report merges retain every run", async () => {
    const resolved = tmpProject("lookout-concurrent-report-");
    await concurrentWorkers(resolved, "merge", ["left", "right"]);
    const report = await loadReport(resolved);
    expect(report?.runs).toHaveLength(20);
    expect(new Set(report?.runs.map((run) => run.id))).toEqual(
      new Set(Array.from({ length: 10 }, (_, n) => [`left-${n}`, `right-${n}`]).flat()),
    );
  });

  test("concurrent queue updates retain both appends", async () => {
    const resolved = tmpProject("lookout-concurrent-queue-");
    await concurrentWorkers(resolved, "queue", ["100001", "100002"]);
    expect((await loadQueue(resolved.projectDir)).map((item) => item.issue).sort()).toEqual(["100001", "100002"]);
  });

  test("concurrent attempt updates retain both appends", async () => {
    const resolved = tmpProject("lookout-concurrent-attempt-");
    await concurrentWorkers(resolved, "attempt", ["1", "2"]);
    const state = await loadState(resolved, "418203");
    expect(state.attempts.map((attempt) => attempt.n).sort()).toEqual([1, 2]);
  });

  test("competing atomic writers use independent temporary files", async () => {
    const resolved = tmpProject("lookout-concurrent-atomic-");
    await concurrentWorkers(resolved, "atomic", ["left", "right"]);
    const path = join(resolved.projectDir, ".lookout", "competing-writers.json");
    const final = JSON.parse(await readFile(path, "utf8")) as { worker: string; sequence: number };
    expect(["left", "right"]).toContain(final.worker);
    expect(final.sequence).toBe(99);
    expect((await readdir(join(resolved.projectDir, ".lookout"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("concurrent backlog updates retain both intents", async () => {
    const resolved = tmpProject("lookout-concurrent-backlog-");
    await concurrentWorkers(resolved, "backlog", ["left", "right"]);
    const backlog = JSON.parse(await readFile(backlogPath(resolved), "utf8")) as { testIntents: string[] };
    expect(backlog.testIntents.sort()).toEqual(["left", "right"]);
  });
});

describe("backlog projection recovery", () => {
  for (const state of ["old authority", "committed authority"] as const) {
    test(`replays projections from ${state}`, async () => {
      const resolved = tmpProject(`lookout-backlog-recovery-${state.replace(" ", "-")}-`);
      const backlog = emptyBacklog(resolved.project, state === "old authority" ? "2026-01-01T00:00:00.000Z" : "2026-02-01T00:00:00.000Z");
      if (state === "committed authority") {
        const finding = {
          fingerprint: "app.root.rest.desktop.dark.spacing.rhythm",
          target: "app",
          route: "/",
          state: "rest",
          platform: "web",
          formFactor: "desktop",
          scheme: "dark",
          category: "spacing",
          attribute: "rhythm",
          severity: "medium",
          status: "open",
          reason: null,
          title: "Spacing needs repair",
          problem: "Rows collide",
          expected: "Rows have space",
          observed: "Rows touch",
          channel: "ai",
          confidence: "high",
          verified: true,
          evidence: [],
          firstSeen: "run-1",
          lastSeen: "run-1",
          fixAttempts: 0,
          fixedIn: null,
        } as BacklogFinding;
        backlog.findings[finding.fingerprint] = finding;
        reconcileIssues(backlog, "2026-02-01T00:00:00.000Z");
      }
      await mkdir(join(resolved.projectDir, ".lookout"), { recursive: true });
      await atomicWriteJson(backlogPath(resolved), backlog);
      await atomicWriteJson(backlogPendingPath(resolved), { schema: 1, startedAt: new Date().toISOString() });
      await writeFile(markdownPath(resolved), "stale projection\n");
      expect((await loadBacklog(resolved)).updatedAt).toBe(backlog.updatedAt);
      expect(await readFile(markdownPath(resolved), "utf8")).toBe(renderMarkdown(backlog));
      expect(existsSync(backlogPendingPath(resolved))).toBe(false);
      if (state === "committed authority") {
        expect(existsSync(issueDir(resolved, Object.keys(backlog.issues)[0]!))).toBe(true);
      }
    });
  }
});

test("a UI mutation reports a busy project as HTTP 409", async () => {
  const resolved = tmpProject("lookout-ui-busy-");
  setCurrentProject(resolved);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lock = withStateLock(resolved, "project", async () => {
    entered();
    await gate;
  });
  await held;
  try {
    const response = await handle(new Request("http://localhost/api/reset", { method: "POST" }), {} as never);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ why: expect.stringContaining("project state is busy:") });
  } finally {
    release();
    await lock;
  }
});

test("reset refuses a foreign project lease and preserves the lock directory", async () => {
  const resolved = tmpProject("lookout-reset-foreign-lock-");
  const barrier = join(resolved.projectDir, "hold-project.start");
  const child = Bun.spawn([process.execPath, workerScript], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      LOOKOUT_TEST_ACTION: "hold-project",
      LOOKOUT_TEST_BARRIER: barrier,
      LOOKOUT_TEST_PROJECT: JSON.stringify(resolved),
      LOOKOUT_TEST_WORKER: "holder",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await until(() => existsSync(`${barrier}.holder.ready`));
  await writeFile(barrier, "start\n");
  await until(() => existsSync(`${barrier}.held`));
  try {
    const outcome = await resetProject(resolved);
    expect(outcome.ok).toBe(false);
    expect(outcome.why).toContain("project state is busy:");
    expect(existsSync(join(resolved.projectDir, ".lookout", "locks"))).toBe(true);
  } finally {
    await writeFile(`${barrier}.release`, "release\n");
    expect(await child.exited).toBe(0);
  }
  expect(existsSync(join(resolved.projectDir, ".lookout", "locks"))).toBe(true);
});

test("a stale directory lease left by a killed process is reclaimed", async () => {
  const resolved = tmpProject("lookout-crashed-lock-");
  const barrier = join(resolved.projectDir, "crash-lock.start");
  const child = Bun.spawn([process.execPath, workerScript], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      LOOKOUT_TEST_ACTION: "hold-project",
      LOOKOUT_TEST_BARRIER: barrier,
      LOOKOUT_TEST_PROJECT: JSON.stringify(resolved),
      LOOKOUT_TEST_WORKER: "crasher",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await until(() => existsSync(`${barrier}.crasher.ready`));
  await writeFile(barrier, "start\n");
  await until(() => existsSync(`${barrier}.held`));
  child.kill(9);
  expect(await child.exited).not.toBe(0);
  const target = lockTarget(resolved, "project");
  expect((await stat(target)).isDirectory()).toBe(true);
  const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
  await utimes(target, old, old);
  let reclaimed = false;
  await withStateLock(resolved, "project", async () => { reclaimed = true; }, { timeoutMs: 0 });
  expect(reclaimed).toBe(true);
});

test("atomic replacement never exposes invalid JSON to readers", async () => {
  const resolved = tmpProject("lookout-atomic-json-");
  const path = join(resolved.projectDir, ".lookout", "atomic.json");
  await atomicWriteJson(path, { sequence: -1, payload: "ready" });
  let finished = false;
  const writer = (async () => {
    for (let sequence = 0; sequence < 100; sequence += 1) {
      await atomicWriteJson(path, { sequence, payload: String(sequence).repeat(2_000) });
    }
    finished = true;
  })();
  let reads = 0;
  while (!finished) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { sequence: number };
    expect(parsed.sequence).toBeNumber();
    reads += 1;
    await Bun.sleep(0);
  }
  await writer;
  expect(reads).toBeGreaterThan(0);
});
