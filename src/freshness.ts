/**
 * Whether a target is serving a build older than the source on disk.
 *
 * A verdict is only as good as the pixels it was made from. A server holding a
 * stale build renders a page that is complete, valid, and not the code that was
 * written, so the run comes back clean and wrong. That is worse than a missed
 * finding, because nothing in the report says to look again. This is the
 * app-side twin of `warnIfStale()` in cli.ts, which says the same thing about
 * lookout's own build, and which exists because a stale build is invisible.
 *
 * It reads only what the server volunteers and what is on disk: no config, no
 * knowledge of any project, and nothing started. A server that sends no
 * `Last-Modified` is silent here, which is the hot-reload case where the served
 * page is compiled per request and already fresh. A static server in front of a
 * built directory sends that file's own timestamp, and that is the case this
 * catches: the build ran, then the code moved on, and nobody rebuilt.
 *
 * Every answer is "stale" or "no opinion". Nothing here ever reports fresh,
 * because a header that is missing is not evidence of freshness.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TargetStatus } from "./targets.js";

/**
 * Directories that never hold the source a build is made from. Dot-directories
 * are skipped wholesale, so `.git`, `.next` and `.lookout` need no entry here.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "Pods",
  "__pycache__",
]);

/**
 * What counts as source: files whose edit leaves a built page out of date.
 *
 * Prose formats are deliberately absent. A repository's changelog and readme
 * change for reasons that have nothing to do with the rendered app, and a
 * check that cries stale after every release note would be turned off within a
 * week. A docs site whose content is markdown is the case this gives up, and
 * giving up quietly is the right trade against a false alarm on every run.
 */
const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
]);

/** How far the walk goes before it declines to answer rather than guess. */
const MAX_ENTRIES = 20_000;
const MAX_MS = 750;

/**
 * Below this, a gap is timestamp granularity rather than a stale build.
 *
 * Small on purpose. The case worth catching is an edit made a moment ago
 * against a build made before it, which is exactly when someone is checking
 * whether their fix worked, so a generous window would sleep through the one
 * run that most needed the warning.
 */
export const STALE_SLACK_MS = 5_000;

export interface WalkOpts {
  /** Entries visited before the walk gives up. */
  maxEntries?: number;
  /** Wall time in milliseconds before the walk gives up. */
  maxMs?: number;
}

/**
 * The newest mtime among a project's source files, or null when the walk
 * cannot answer: the directory is unreadable, nothing under it is source, or a
 * cap tripped on a tree too large to scan inside a capture's patience.
 *
 * Null is "no opinion", never "fresh", so every caller falls silent instead of
 * asserting something it did not measure.
 */
export function newestSourceMtime(projectDir: string, opts: WalkOpts = {}): number | null {
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const maxMs = opts.maxMs ?? MAX_MS;
  const started = Date.now();
  let seen = 0;
  let newest = 0;
  const stack: string[] = [projectDir];
  try {
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++seen > maxEntries) return null;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
            stack.push(join(dir, entry.name));
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const dot = entry.name.lastIndexOf(".");
        if (dot < 1 || !SOURCE_EXT.has(entry.name.slice(dot))) continue;
        const at = statSync(join(dir, entry.name)).mtimeMs;
        if (at > newest) newest = at;
      }
      if (Date.now() - started > maxMs) return null;
    }
  } catch {
    return null;
  }
  return newest > 0 ? newest : null;
}

export interface StaleTarget {
  name: string;
  url: string;
  /** What the server said it served, epoch milliseconds. */
  servedAt: number;
  /** The newest source file on disk, epoch milliseconds. */
  newestSource: number;
  /** How far behind the served build is, in whole minutes, at least 1. */
  behindMinutes: number;
}

/**
 * The targets serving something older than the source, widest gap first.
 *
 * Silent for any target that sent no `Last-Modified`, and silent when the walk
 * had no opinion, because one unknown on either side leaves nothing to compare.
 */
export function staleTargets(
  statuses: readonly TargetStatus[],
  newestSource: number | null,
  slackMs = STALE_SLACK_MS,
): StaleTarget[] {
  if (newestSource === null) return [];
  const out: StaleTarget[] = [];
  for (const s of statuses) {
    if (s.servedAt === null || !s.up) continue;
    const behind = newestSource - s.servedAt;
    if (behind <= slackMs) continue;
    out.push({
      name: s.name,
      url: s.url,
      servedAt: s.servedAt,
      newestSource,
      behindMinutes: Math.max(1, Math.round(behind / 60_000)),
    });
  }
  return out.sort((a, b) => b.behindMinutes - a.behindMinutes);
}

/**
 * Why this run's evidence may not show the current code, or null when there is
 * no reason to doubt it. A value rather than a throw, so the caller decides
 * whether it warns or blocks. Nothing calls this and then refuses a run:
 * lookout never starts or rebuilds anything, and a warning the operator can act
 * on beats a run they cannot make happen.
 */
export function staleMessage(stale: readonly StaleTarget[]): string | null {
  if (stale.length === 0) return null;
  const lines = stale.map(
    (s) =>
      `  ${s.name}: ${s.url} is serving a build ${s.behindMinutes} minute(s) older than the newest source file`,
  );
  return (
    `target(s) may be serving a stale build:\n${lines.join("\n")}\n` +
    "  lookout photographs what is served, not what is written; rebuild and restart\n" +
    "  the server before trusting this run"
  );
}

/** The sibling of `downReason()`, from statuses rather than a computed list. */
export function staleReason(
  statuses: readonly TargetStatus[],
  newestSource: number | null,
  slackMs = STALE_SLACK_MS,
): string | null {
  return staleMessage(staleTargets(statuses, newestSource, slackMs));
}

/**
 * What a suspect run records about itself, in a shape a report can print.
 *
 * Timestamps become ISO strings here because this ends up in a run's flags and
 * from there in an issue document, where epoch milliseconds tell a reader
 * nothing about whether the evidence was worth trusting.
 */
export interface StaleStamp {
  target: string;
  url: string;
  behindMinutes: number;
  servedAt: string;
  newestSource: string;
}

export function staleStamp(stale: readonly StaleTarget[]): StaleStamp[] {
  return stale.map((s) => ({
    target: s.name,
    url: s.url,
    behindMinutes: s.behindMinutes,
    servedAt: new Date(s.servedAt).toISOString(),
    newestSource: new Date(s.newestSource).toISOString(),
  }));
}
