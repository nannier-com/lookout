/**
 * The lookout home: what is left of it.
 *
 * `LOOKOUT_HOME` (default `~/.lookout`) used to hold everything that was not
 * the durable record of a judged project: the incident log, the heals, the
 * self-heal attempts, the ui settings and one capture workspace per project.
 * The workspace has moved into each project's own gitignored `.lookout/`
 * (`evidenceDir` in config.ts); the rest follow, and this file goes with the
 * last of them.
 *
 * Nothing new may be given a path under here.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Overridable so a test does not write into the operator's home. */
export function lookoutHome(): string {
  return process.env.LOOKOUT_HOME ?? join(homedir(), ".lookout");
}
