/**
 * The one thing this server starts: a check of the project it is pointed at.
 *
 * The page has a play button, so the server has to be able to run lookout. It
 * runs the CLI as a child rather than calling the verb in process, because a
 * check writes to the event log the page is already tailing, and because a run
 * that dies must not take the viewer down with it.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  const child = spawn(process.execPath, args, {
    cwd: project.projectDir,
    // stderr is kept, not discarded: it carries the only explanation a failed
    // run ever produces.
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
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
    if (code !== null && code > 1) {
      session.lastFailure = { code, message: tailLines(stderr) || `check exited ${code}` };
    }
    session.running = null;
    void pushNow();
  });
  session.lastFailure = null;
  session.running = { child, projectDir: project.projectDir };
  void pushNow();
  return { started: true };
}

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
