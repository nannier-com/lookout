/**
 * Stopping a run, and the judge underneath it.
 *
 * The reason this test exists at all is that a check is not one process. It
 * spawns the Claude CLI per batch, and that grandchild is where the model time
 * is spent, so a stop that signals only the child leaves a judge thinking about
 * a run nobody is waiting for. That failure is invisible from the page: the
 * button goes back to green, the board goes quiet, and a process keeps working.
 *
 * So the tree here is real. A parent that spawns a long-lived child, spawned
 * with the very options `startCheck` uses, and the assertion is that both are
 * gone afterwards rather than that a function was called.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../src/config.js";
import { eventsPath, readEvents, summarise } from "../src/report/events.js";
import { handle } from "../src/ui/routes.js";
import { checkSpawnOptions, stopCheck } from "../src/ui/run.js";
import { checkIsRunning, checkIsStopping, session, setCurrentProject } from "../src/ui/session.js";
import { statusBody } from "../src/ui/payload.js";
import { tmpProject } from "./tmp-project.js";
import type { StatusPayload } from "../src/ui/payload.js";

// The pin this file used to carry is gone with the variable it pinned:
// `evidenceDir` and `eventsPath` are pure functions of the project directory
// now, so another test file cannot pull this one's directory out from under it
// by redirecting a global.

const project = tmpProject("lookout-stop-");
mkdirSync(evidenceDir(project), { recursive: true });
writeFileSync(eventsPath(project), "");
setCurrentProject(project);

/** A stand-in for the check: it spawns something long-lived, the way judging does. */
const PARENT = join(project.projectDir, "parent.mjs");
const KID_FILE = join(project.projectDir, "kid.json");
writeFileSync(
  PARENT,
  [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    // The grandchild: stands in for `claude -p`, which outlives its parent
    // unless the whole group is signalled.
    'const kid = spawn("sleep", ["120"], { stdio: ["ignore", "ignore", "ignore"] });',
    // Through a file rather than stdout, because a run's stdout is discarded:
    // the page reads the event log, not a pipe. See `checkSpawnOptions`.
    `writeFileSync(${JSON.stringify(KID_FILE)}, String(kid.pid));`,
    "setTimeout(() => {}, 120000);",
  ].join("\n"),
);

const started: ChildProcess[] = [];

afterAll(() => {
  session.running = null;
  for (const c of started) {
    try {
      if (c.pid !== undefined) process.kill(-c.pid, "SIGKILL");
    } catch {
      // Already gone, which is what the tests are asserting anyway.
    }
  }
});

/** Whether a pid still exists. Signal 0 asks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process group a pid belongs to, straight from the operating system. */
function pgid(pid: number): number {
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)]).toString().trim());
}

async function until(ok: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await Bun.sleep(20);
  }
  return ok();
}

/** A live two-deep tree installed as the run in flight, as `startCheck` leaves it. */
async function runningTree(): Promise<{ parent: number; kid: number }> {
  rmSync(KID_FILE, { force: true });
  const child = spawn(process.execPath, [PARENT], checkSpawnOptions(project.projectDir));
  started.push(child);
  // The parent writes its own child's pid down, which is the only way to know
  // the grandchild's fate from out here.
  await until(() => existsSync(KID_FILE));
  session.running = { child, project, stopping: false, kind: "check" };
  return { parent: child.pid!, kid: Number(readFileSync(KID_FILE, "utf8")) };
}

describe("stopping a run", () => {
  test("the run is spawned into a process group of its own", async () => {
    const { parent, kid } = await runningTree();
    // Not this server's group, which is what makes signalling the run possible
    // at all: `kill(-pid)` on a shared group would take the ui down with it.
    expect(pgid(parent)).not.toBe(pgid(process.pid));
    // The group leader is the run itself, so its pid IS the group's id.
    expect(pgid(parent)).toBe(parent);
    // And the judge is inside it, which is the whole point.
    expect(pgid(kid)).toBe(parent);
    stopCheck();
    await until(() => !alive(parent) && !alive(kid));
  });

  test("stopping kills the judge underneath, not just the run", async () => {
    const { parent, kid } = await runningTree();
    expect(alive(parent)).toBe(true);
    expect(alive(kid)).toBe(true);

    expect(stopCheck()).toEqual({ stopped: true });
    // Measured before this feature existed: the parent died and this stayed
    // true, indefinitely.
    expect(await until(() => !alive(kid))).toBe(true);
    expect(alive(parent)).toBe(false);
  });

  test("a second press is the same stop, not a second signal", async () => {
    const { parent, kid } = await runningTree();
    expect(stopCheck()).toEqual({ stopped: true });
    expect(stopCheck()).toEqual({ stopped: true, reason: "already stopping" });
    // Until it is gone, the page is told the press landed rather than offered
    // the button again.
    expect(checkIsStopping()).toBe(true);
    await until(() => !alive(parent) && !alive(kid));
  });

  test("the payload carries the stopping state, cache or no cache", async () => {
    const { parent, kid } = await runningTree();
    const before = JSON.parse(await statusBody(project)) as StatusPayload;
    expect(before.status.checkRunning).toBe(true);
    expect(before.status.checkStopping).toBe(false);
    stopCheck();
    // Nothing on disk moved, so this is exactly the case a cache keyed on the
    // disk alone would answer wrongly.
    const after = JSON.parse(await statusBody(project)) as StatusPayload;
    expect(after.status.checkStopping).toBe(true);
    await until(() => !alive(parent) && !alive(kid));
  });

  test("the log is told the run ended, because the run cannot say so", async () => {
    const { parent, kid } = await runningTree();
    const runId = "stopped-run";
    // Defensive, the way `EventLog.start`/`.join` always are before they write:
    // this is a raw write standing in for what would normally go through that
    // class, and it should not assume the directory it created at module load
    // is still there any more than the real thing does.
    mkdirSync(evidenceDir(project), { recursive: true });
    writeFileSync(
      eventsPath(project),
      JSON.stringify({ at: new Date().toISOString(), runId, kind: "run-start", message: "check" }) + "\n",
    );
    expect(summarise(readEvents(project)).running).toBe(true);
    stopCheck();
    await until(() => !alive(parent) && !alive(kid));
    // The exit handler writes the run-end a killed process never got to write.
    expect(await until(() => summarise(readEvents(project)).running === false)).toBe(true);
    const status = summarise(readEvents(project));
    // Not "done": it did not finish, it was stopped.
    expect(status.phase).toBe("stopped");
    expect(status.endedAt).not.toBeNull();
    // A deliberate stop is not a failure, so nothing is shown in red.
    expect(session.lastFailure).toBeNull();
  });

  test("nothing running is a 409, not a success for a signal nobody received", async () => {
    session.running = null;
    expect(checkIsRunning()).toBe(false);
    const res = await handle(
      new Request("http://127.0.0.1/api/stop", { method: "POST" }),
      null as never,
    );
    expect(res?.status).toBe(409);
    expect(await res?.json()).toEqual({ stopped: false, reason: "nothing is running" });
  });
});
