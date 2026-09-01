/**
 * The state one `lookout ui` process carries between requests.
 *
 * A server is a pile of handlers, and every one of them needs to know the same
 * four things: which project is being served, what was remembered about where
 * to look, whether a check is in flight, and why the last one died. Those used
 * to be module-level `let`s in the middle of the request router, which is why
 * nothing else could be moved out of it.
 *
 * The project is behind an accessor rather than exported directly, because it
 * is the one piece with no sensible empty value: the verb resolves it before
 * the server ever listens, and a handler reading it earlier is a bug worth an
 * exception rather than a silent empty board.
 */
import type { ChildProcess } from "node:child_process";
import { LookoutError, type ResolvedConfig } from "../types.js";
import type { UiSettings } from "./stored-settings.js";

/**
 * The project being served. Mutable, because the page can point lookout at a
 * different repository: `lookout ui` is then a viewer you leave open rather
 * than one bound for life to the directory it was launched in.
 */
let project: ResolvedConfig | null = null;

export function currentProject(): ResolvedConfig {
  if (!project) {
    throw new LookoutError("the ui has no project yet", "this is a bug: the verb resolves one before it listens");
  }
  return project;
}

/**
 * The project, or null when there is not one yet.
 *
 * The settings panel is the one reader that legitimately runs before anything
 * is configured: it is the screen you open to configure it. Everything else
 * wants the throwing accessor.
 */
export function currentProjectOrNull(): ResolvedConfig | null {
  return project;
}

/**
 * What to redo when lookout is pointed somewhere else.
 *
 * The page can change projects, and two things have to follow it: the board
 * cache, which would otherwise serve the previous project's issues, and the
 * watcher, which would otherwise be watching the previous project's
 * directories. The cache is invalidated at the call site because that reads as
 * part of switching; the watcher is not, because it is started once by the verb
 * and nothing in the switch should have to know it exists.
 */
const listeners: (() => void)[] = [];

export function onProjectChange(fn: () => void): void {
  listeners.push(fn);
}

export function setCurrentProject(next: ResolvedConfig): void {
  project = next;
  for (const fn of listeners) fn();
}

export const session: {
  /** Where the page has been pointed, and where the app actually is. */
  settings: UiSettings;
  /**
   * The check in flight, if the page started one.
   *
   * It carries the project it was started against rather than only that
   * project's directory, because a run can be stopped after the page has been
   * pointed somewhere else, and what has to be written down then is the end of
   * THIS run, in the log it was narrating to.
   *
   * `stopping` is set the moment somebody presses stop and stays set until the
   * child is gone. It is what tells the exit handler that the run was ended on
   * purpose rather than that it fell over, and what stops a second press from
   * signalling a group that is already closing its browser.
   */
  running: { child: ChildProcess; project: ResolvedConfig; stopping: boolean } | null;
  /**
   * Why the last run this page started ended badly, if it did.
   *
   * The child used to be spawned with its output discarded and only an `error`
   * handler attached, which fires when the process cannot be LAUNCHED and never
   * when it exits non-zero. A run that started and died a second later (target
   * down, unreadable config, nothing captured) left the page idle and blank
   * with the one artifact that explained it, its stderr, thrown away.
   */
  lastFailure: { code: number | null; message: string } | null;
} = {
  settings: { projectDir: null, baseUrl: null, navigationFor: null },
  running: null,
  lastFailure: null,
};

export function checkIsRunning(): boolean {
  const r = session.running;
  return r !== null && r.child.exitCode === null && !r.child.killed;
}

/**
 * Whether the run in flight has been told to stop and has not gone yet.
 *
 * A separate question from whether one is running, because for the second or
 * two between the signal and the last browser closing, both are true: the page
 * has to say the press landed rather than offer the button again.
 */
export function checkIsStopping(): boolean {
  return checkIsRunning() && session.running?.stopping === true;
}
