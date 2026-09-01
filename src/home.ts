/**
 * The lookout home: machine-wide state, and each project's capture workspace.
 *
 * `LOOKOUT_HOME` (default `~/.lookout`) holds what belongs to the operator's
 * machine rather than to any judged project: the incident log, the heals, the
 * ui settings, and one capture workspace per project. A workspace is working
 * state lookout can rebuild with a single capture; the durable record of a
 * defect lives with the project, in its issue folders under `.lookout/`.
 *
 * Workspaces are keyed by the project's real path, so two checkouts of one
 * project each get their own and a symlinked spelling of the same directory
 * (macOS `/tmp` vs `/private/tmp`) does not split one project into two. The
 * basename rides along in the key so a human reading the home directory can
 * tell which workspace is whose.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Overridable so a test does not write into the operator's home. */
export function lookoutHome(): string {
  return process.env.LOOKOUT_HOME ?? join(homedir(), ".lookout");
}

// Real paths do not change while a process runs; the env var can (tests set
// and restore it), which is why only this half is memoised.
const keys = new Map<string, string>();

/** `<basename>-<10 hex of the real path>`: one workspace per checkout. */
export function workspaceKey(projectDir: string): string {
  const cached = keys.get(projectDir);
  if (cached) return cached;
  let real: string;
  try {
    real = realpathSync(projectDir);
  } catch {
    real = resolve(projectDir);
  }
  const slug =
    basename(real)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const key = `${slug}-${createHash("sha256").update(real).digest("hex").slice(0, 10)}`;
  keys.set(projectDir, key);
  return key;
}
