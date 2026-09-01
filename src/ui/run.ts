/**
 * The one thing this server starts: a check of the project it is pointed at,
 * and the one thing it can take back.
 *
 * The page has a play button, so the server has to be able to run lookout. It
 * runs the CLI as a child rather than calling the verb in process, because a
 * check writes to the event log the page is already tailing, and because a run
 * that dies must not take the viewer down with it.
 *
 * Stopping is not the mirror image of starting, because a check is not one
 * process. It spawns the Claude CLI once per batch, and that grandchild is
 * where the minutes and the model spend actually go. Signalling the child alone
 * orphans it: measured on 2026-09-01, a parent killed with SIGTERM left its
 * child running to completion, which is a judge still thinking about a run
 * nobody is waiting for any more. So the run is given a process group of its
 * own and the group is what gets signalled.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventLog, readEvents, summarise } from "../report/events.js";
import { downReason, preflight, resolveTargets } from "../targets.js";
import { pushNow } from "./live.js";
import { session } from "./session.js";
import { navigationConsented } from "./stored-settings.js";
import type { ResolvedConfig } from "../types.js";

export async function startCheck(project: ResolvedConfig): Promise<{ started: boolean; reason?: string }> {
  if (session.running && session.running.child.exitCode === null) {
    return { started: false, reason: "a check is already running" };
  }
  if (!project.configPath) {
    return { started: false, reason: "no lookout.config.ts in that folder" };
  }

  // Ask whether the app is even reachable before spending a run on it. The CLI
  // path would throw `requireUp` moments from now; doing it here means the page
  // can say which target is down and how to start it, instead of showing
  // nothing while a doomed subprocess exits into a discarded pipe.
  try {
    const reason = downReason(
      await preflight(resolveTargets(project.config, undefined, undefined, project.configPath)),
    );
    if (reason) return { started: false, reason };
  } catch (e) {
    // A config that cannot even be resolved into targets is itself the answer.
    return { started: false, reason: (e as Error).message };
  }
  // lookout runs itself: this verb is lookout doing its own job, which is
  // finding issues and writing them down. It narrates to the event log as it
  // goes, and the page is already tailing that.
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  // --first: one run, stopping at the first issue. The loop this button serves
  // is find one, fix one, verify it, so judging on for another eight minutes to
  // hand back twenty-six more answers a question nobody has asked yet.
  const args = [cli, "check", "--quiet", "--first"];
  // The toggle beside the button, spent one run at a time. It is passed only
  // for the project it was given for, so a page pointed somewhere new starts
  // from no again: what this authorizes is clicking the application's own
  // controls, destructive ones included, and that is a promise about one
  // repository rather than a preference the page carries around.
  if (navigationConsented(session.settings, project.projectDir)) args.push("--navigation");
  const child = spawn(process.execPath, args, checkSpawnOptions(project.projectDir));
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString();
  });
  child.on("error", (err) => {
    session.lastFailure = { code: null, message: err.message };
    session.running = null;
    // Whether a run is in flight is not written down anywhere the watcher can
    // see, so these three transitions say so themselves. Without them the page
    // would wait on the backstop to notice a run that has already died.
    void pushNow();
  });
  // Exit codes are contractual: 1 findings, 2 execution error, 3 blocked. Only
  // 2 and unexpected codes are failures worth surfacing; 0 and 1 are answers.
  child.on("exit", (code) => {
    // A run somebody stopped did not fail, so it says nothing in red. What it
    // does say is that it ended, which `stopCheck` writes down from its own
    // handler because that is the path that knows the ending was deliberate.
    if (session.running?.stopping !== true && code !== null && code > 1) {
      session.lastFailure = { code, message: tailLines(stderr) || `check exited ${code}` };
    }
    session.running = null;
    void pushNow();
  });
  session.lastFailure = null;
  session.running = { child, project, stopping: false };
  void pushNow();
  return { started: true };
}

/**
 * How a run is spawned. Exported because one of these fields is the feature.
 *
 * `detached` is what puts the run in a process group of its own, and that group
 * is the only handle by which the Claude CLI underneath it can be reached: a
 * signal to the child alone leaves the judge thinking. The test spawns a tree
 * with these exact options and proves the group actually forms, because a
 * `detached` quietly dropped here would leave every other part of stopping
 * working and still orphan the process that costs money.
 *
 * The cost of the flag is that Ctrl-C on this server no longer reaches the run,
 * since a terminal signals its foreground group and the run has left it.
 * `lookout ui` pays that back by stopping the run itself on the way out.
 */
export function checkSpawnOptions(cwd: string): SpawnOptions {
  return {
    cwd,
    // stderr is kept, not discarded: it carries the only explanation a failed
    // run ever produces.
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  };
}

/**
 * Stop the run this server started, and everything under it.
 *
 * Idempotent: pressing stop twice is one stop, because the second press lands
 * while the first is still closing a browser.
 */
export function stopCheck(): { stopped: boolean; reason?: string } {
  const run = session.running;
  if (!run || run.child.exitCode !== null) return { stopped: false, reason: "nothing is running" };
  if (run.stopping) return { stopped: true, reason: "already stopping" };
  run.stopping = true;
  // Written down when the run is actually gone rather than when the signal is
  // sent, because until then it is still running. Registered here rather than
  // where the run was started, so the path that knows the ending was
  // deliberate is the one that records it.
  const project = run.project;
  run.child.once("exit", () => recordStopped(project));
  // SIGTERM first, and that is not politeness. A check drives a chromium that
  // playwright launched into a process group of its own, out of reach of the
  // signal below, and playwright's own SIGTERM handler is what closes it.
  // Killing outright would leave a browser running with nobody left to shut it
  // down.
  signalGroup(run.child, "SIGTERM");
  const dying = run.child;
  const grace = setTimeout(() => {
    // Still there after the grace period: it is not closing, it is stuck.
    if (dying.exitCode === null) signalGroup(dying, "SIGKILL");
  }, GRACE_MS);
  // The timer must not be a reason for this server to stay up.
  grace.unref?.();
  // Nothing on disk moved, so the page would not be told otherwise, and what
  // it has to hear is that the button was pressed.
  void pushNow();
  return { stopped: true };
}

/**
 * Signal the run's whole process group.
 *
 * The negative pid is the point: it reaches the check, the Claude CLI it is
 * waiting on, and anything either of them started. If the group is already
 * gone the child is signalled on its own, which costs nothing and covers the
 * platform where the group never formed.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone. The exit handler has run or is about to.
    }
  }
}

/**
 * Write down that the run ended, because the run cannot.
 *
 * A killed process emits no `run-end`, so the log goes on claiming it is
 * running and the page animates a clock for it until ten minutes of silence
 * make it "stalled". lookout normally cannot see a run die, which is what that
 * staleness rule exists for; this is the one case where it can, because it is
 * the one that killed it.
 */
function recordStopped(project: ResolvedConfig): void {
  const status = summarise(readEvents(project));
  if (!status.running || !status.runId) return;
  new EventLog(project, status.runId).emit("run-end", "stopped from the page", { stopped: true });
}

/** How long a stopped run gets to close its browser before it is killed outright. */
const GRACE_MS = 4000;

/** Cap on retained stderr: enough to carry a LookoutError and its hint. */

const MAX_STDERR = 4000;

/** The last few non-empty lines, which is where a CLI puts its actual message. */
function tailLines(text: string, lines = 4): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-lines)
    .join("\n");
}
