import { existsSync } from "node:fs";
import { join } from "node:path";

import { mergeRun } from "../src/capture/store.js";
import { updateBacklog } from "../src/backlog/store.js";
import { atomicWriteJson } from "../src/state/atomic.js";
import { withStateLock } from "../src/state/lock.js";
import { recordAttempt } from "../src/verify/attempt.js";
import { updateQueue } from "../src/ui/queue.js";
import type { ResolvedConfig, RunRecord } from "../src/types.js";

const action = process.env.LOOKOUT_TEST_ACTION;
const worker = process.env.LOOKOUT_TEST_WORKER ?? "worker";
const barrier = process.env.LOOKOUT_TEST_BARRIER;
const rawProject = process.env.LOOKOUT_TEST_PROJECT;

if (!action || !barrier || !rawProject) {
  throw new Error("state concurrency worker is missing its test environment");
}

const resolved = JSON.parse(rawProject) as ResolvedConfig;
await Bun.write(`${barrier}.${worker}.ready`, "ready\n");
const deadline = Date.now() + 5_000;
while (!existsSync(barrier)) {
  if (Date.now() > deadline) throw new Error("state concurrency worker timed out at the barrier");
  await Bun.sleep(5);
}

if (action === "merge") {
  for (let n = 0; n < 10; n += 1) {
    const run: RunRecord = {
      id: `${worker}-${n}`,
      kind: "web",
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:00:01.000Z",
      flags: {},
      failures: [],
      skips: [],
    };
    await mergeRun(resolved, run, []);
  }
} else if (action === "queue") {
  await updateQueue(resolved.projectDir, async (items) => {
    await Bun.sleep(75);
    items.push({
      issue: worker,
      tools: ["claude-code"],
      queuedAt: "2026-09-02T00:00:00.000Z",
    });
  });
} else if (action === "attempt") {
  await recordAttempt(resolved, "418203", {
    n: Number(worker),
    dispatchedAt: "2026-09-02T00:00:00.000Z",
    reported: { commit: `commit-${worker}` },
  });
} else if (action === "atomic") {
  const path = join(resolved.projectDir, ".lookout", "competing-writers.json");
  for (let sequence = 0; sequence < 100; sequence += 1) {
    await atomicWriteJson(path, { worker, sequence, payload: worker.repeat(2_000) });
  }
} else if (action === "backlog") {
  await updateBacklog(resolved, async (backlog) => {
    await Bun.sleep(75);
    const record = backlog as typeof backlog & { testIntents?: string[] };
    record.testIntents ??= [];
    record.testIntents.push(worker);
  });
} else if (action === "hold-project") {
  await withStateLock(resolved, "project", async () => {
    await Bun.write(`${barrier}.held`, "held\n");
    while (!existsSync(`${barrier}.release`)) await Bun.sleep(5);
  });
} else {
  throw new Error(`unknown state concurrency action: ${action}`);
}
