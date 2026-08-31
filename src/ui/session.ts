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

export function setCurrentProject(next: ResolvedConfig): void {
  project = next;
}

export const session: {
  /** Where the page has been pointed, and where the app actually is. */
  settings: UiSettings;
  /** The check in flight, if the page started one. */
  running: { child: ChildProcess; projectDir: string } | null;
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
  settings: { projectDir: null, baseUrl: null },
  running: null,
  lastFailure: null,
};

export function checkIsRunning(): boolean {
  const r = session.running;
  return r !== null && r.child.exitCode === null && !r.child.killed;
}
