/**
 * Where a project's lookout config lives.
 *
 * It is `lookout.config.ts` in the project root, beside `package.json`, where
 * every other tool keeps its config and where git tracks it without anyone
 * having to un-ignore anything. `.lookout/config.*` was the old home; it still
 * loads, and lookout moves it to the root the first time a run finds one
 * (`config-write.ts`), so no checkout is stranded on the old layout.
 *
 * Discovery checks a directory's candidates before climbing to its parent.
 * Ordering by directory rather than by filename is what stops an outer
 * repository's config from beating the one you are standing in.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Root-level candidates, in precedence order within one directory. */
export const CONFIG_BASENAMES = [
  "lookout.config.ts",
  "lookout.config.js",
  "lookout.config.mjs",
  "lookout.config.json",
];

/** The directory holding lookout's working state, and the config's old home. */
export const LOOKOUT_DIR = ".lookout";

/** Pre-root candidates, still loadable and migrated on sight. */
export const LEGACY_BASENAMES = ["config.ts", "config.js", "config.json"];

/** The canonical file lookout writes and maintains. */
export const CONFIG_FILENAME = CONFIG_BASENAMES[0]!;

export interface LocatedConfig {
  /** Absolute path of the config file. */
  path: string;
  /** The project root it implies: evidence and the backlog hang off this. */
  projectDir: string;
  /** True when it was found in the pre-root `.lookout/` home. */
  legacy: boolean;
}

/** The nearest config at or above `start`, or null when there is none. */
export function locateConfig(start: string): LocatedConfig | null {
  let dir = resolve(start);
  for (;;) {
    for (const name of CONFIG_BASENAMES) {
      const path = join(dir, name);
      if (existsSync(path)) return { path, projectDir: dir, legacy: false };
    }
    for (const name of LEGACY_BASENAMES) {
      const path = join(dir, LOOKOUT_DIR, name);
      if (existsSync(path)) return { path, projectDir: dir, legacy: true };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when a config path sits in the pre-root `.lookout/` home. */
export function isLegacyConfigPath(path: string): boolean {
  return basename(dirname(path)) === LOOKOUT_DIR;
}

/**
 * The project root a config path implies, for `--config` as much as for
 * discovery: a file inside `.lookout/` roots at that directory's parent, and a
 * file anywhere else roots where it sits.
 */
export function projectDirFor(path: string): string {
  const dir = dirname(path);
  return isLegacyConfigPath(path) ? dirname(dir) : dir;
}

/**
 * Where a config lookout writes itself should go.
 *
 * A repository root or a package root is a place someone meant to keep files;
 * a directory that is neither is somewhere they happened to be standing, and
 * writing a config file into it would be litter. Returning null is how the
 * caller learns to stay zero-config.
 */
export function nearestProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    for (const marker of [".git", "package.json", LOOKOUT_DIR]) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
