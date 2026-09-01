/**
 * lookout's own config file, written by lookout.
 *
 * `lookout.config.ts` is lookout's file in someone else's repository, so
 * lookout keeps it: it writes one when a run needs a config and the project has
 * none, and it moves the pre-root `.lookout/config.*` up to the root the first
 * time a run finds one there. Nothing here ever overwrites a config that
 * already exists, and every write says on stderr what it did and where.
 *
 * The move is the part that has to be careful. `rubric` and a route's `design`
 * are resolved relative to the config file, so a file that changes directory
 * takes those references with it; migration rewrites each one that pointed
 * inside `.lookout/` and names any it could not rewrite by hand.
 */
import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  CONFIG_FILENAME,
  LEGACY_BASENAMES,
  LOOKOUT_DIR,
  locateConfig,
  nearestProjectRoot,
} from "./config-locate.js";
import { LookoutError, type LookoutConfig } from "./types.js";

/** What a written config should point at, when lookout already knows. */
export interface ConfigSeed {
  /** Base URL from --url: the run that prompted the write. */
  url?: string;
}

export function configTemplate(seed: ConfigSeed = {}): string {
  const url = seed.url ?? "http://localhost:3000";
  const startHint = seed.url
    ? `      // startHint: "bun run dev",   // printed when this target is down\n`
    : `      startHint: "bun run dev",\n`;
  return `import type { LookoutConfig } from "@nannier-com/lookout";

// lookout project config. Targets are the apps this repo renders; lookout
// captures them, judges them, and tracks findings in .lookout/backlog.json.
// lookout writes and maintains this file; it belongs at the project root and
// in git, while everything under .lookout/ is per-checkout working state.
// lookout never starts services: startHint is what it prints when one is down.
const config: LookoutConfig = {
  targets: [
    {
      name: "app",
      url: "${url}",
${startHint}      routes: ["/"],
    },
  ],

  // How this app switches dark/light. "emulate" (default) uses the browser's
  // prefers-color-scheme; use "url-param" when the app reads a query param, or
  // "recipe" and export setScheme(page, scheme) for click choreography.
  // scheme: { mode: "emulate" },

  // Named interaction recipes routes can opt into via states: ["name"].
  // states: {
  //   "menu-open": {
  //     prepare: async (page) => {
  //       await page.getByRole("button", { name: "Menu" }).click();
  //     },
  //     restore: async (page) => {
  //       await page.keyboard.press("Escape");
  //     },
  //   },
  // },

  // Project-specific judging rules, relative to this file.
  // rubric: "./rubric.md",
  // neverFile: ["the marketing hero intentionally overflows on phone"],
};

export default config;
`;
}

/**
 * Write `lookout.config.ts` at a project root. Refuses when the project already
 * has a config anywhere, root or legacy: two configs is a question about which
 * one is live, and lookout does not get to answer it silently.
 */
export async function createConfig(projectDir: string, seed: ConfigSeed = {}): Promise<string> {
  const existing = existingConfigIn(projectDir);
  if (existing) {
    throw new LookoutError(`${existing} already exists`, "edit it in place; lookout never overwrites a config");
  }
  const path = join(projectDir, CONFIG_FILENAME);
  try {
    await writeFile(path, configTemplate(seed));
  } catch (e) {
    throw new LookoutError(
      `could not write ${path}: ${(e as Error).message}`,
      "write it by hand, or run from a directory lookout can write to",
    );
  }
  return path;
}

/** The config already in this directory (root form or legacy), if any. */
export function existingConfigIn(projectDir: string): string | null {
  const found = locateConfig(projectDir);
  return found && found.projectDir === projectDir ? found.path : null;
}

/** The pre-root config in this directory, if one is still there. */
export function legacyConfigIn(projectDir: string): string | null {
  for (const name of LEGACY_BASENAMES) {
    const path = join(projectDir, LOOKOUT_DIR, name);
    if (existsSync(path)) return path;
  }
  return null;
}

export interface Migration {
  from: string;
  to: string;
  /** Config-relative references rewritten to keep pointing where they did. */
  rewritten: string[];
  /** References that moved with the file and now need a hand. */
  unresolved: string[];
}

/**
 * Move a pre-root config to the project root, references included.
 *
 * The config is loaded first, and only to read its path references: a config
 * that will not load still moves, because refusing to migrate it would leave
 * the project on a home lookout is retiring for a problem the move does not
 * cause.
 */
export async function migrateLegacyConfig(legacyPath: string): Promise<Migration> {
  const projectDir = dirname(dirname(legacyPath));
  const to = join(projectDir, `lookout.config${extensionOf(legacyPath)}`);
  if (existsSync(to)) {
    throw new LookoutError(
      `${to} already exists, so ${legacyPath} cannot move there`,
      "keep the root config and delete the one under .lookout/",
    );
  }

  const refs = await configRefs(legacyPath);
  const source = await readFile(legacyPath, "utf8");
  const { text, rewritten, unresolved } = rewriteRefs(source, refs, dirname(legacyPath), projectDir);

  if (text === source) {
    await rename(legacyPath, to);
  } else {
    await writeFile(to, text);
    await unlink(legacyPath);
  }
  return { from: legacyPath, to, rewritten, unresolved };
}

function extensionOf(path: string): string {
  const name = basename(path);
  return name.slice(name.indexOf("."));
}

/** Every config-relative path a config declares: the rubric and route hand-offs. */
async function configRefs(configPath: string): Promise<string[]> {
  let config: LookoutConfig;
  try {
    const { loadConfig } = await import("./config.js");
    config = (await loadConfig({ configPath })).config;
  } catch {
    // A config that will not load has no readable references. The move still
    // happens; the loader will report why it failed at the new path.
    return [];
  }
  const refs: string[] = [];
  if (config.rubric) refs.push(config.rubric);
  for (const target of config.targets) {
    for (const route of target.routes ?? []) {
      if (typeof route !== "string" && route.design) refs.push(route.design);
    }
  }
  return refs.filter((r) => !r.startsWith("/"));
}

/**
 * Repoint the references a directory change would have broken.
 *
 * Only a reference that resolved to something real from the old location is
 * rewritten: one that was already broken is the project's own business, and
 * inventing a path for it would bury that. A value the source spells more than
 * once is reported instead of guessed at.
 */
function rewriteRefs(
  source: string,
  refs: string[],
  oldDir: string,
  newDir: string,
): { text: string; rewritten: string[]; unresolved: string[] } {
  let text = source;
  const rewritten: string[] = [];
  const unresolved: string[] = [];
  for (const ref of new Set(refs)) {
    if (!existsSync(join(oldDir, ref))) continue;
    const replacement = relative(newDir, join(oldDir, ref)).split("\\").join("/");
    const spellings = [`"${ref}"`, `'${ref}'`, `\`${ref}\``].filter((s) => text.includes(s));
    const hits = spellings.reduce((n, s) => n + text.split(s).length - 1, 0);
    if (hits === 1 && spellings[0]) {
      const quote = spellings[0][0]!;
      text = text.replace(spellings[0], `${quote}${replacement}${quote}`);
      rewritten.push(`${ref} -> ${replacement}`);
    } else {
      unresolved.push(ref);
    }
  }
  return { text, rewritten, unresolved };
}

export interface EnsureOptions {
  cwd: string;
  /** --config: an explicit path means the caller has already chosen a file. */
  configPath?: string;
  /** --url: what a written config should point at. */
  url?: string;
}

/**
 * Make sure the project has a config where lookout keeps one, before a verb
 * goes looking for it.
 *
 * Three outcomes: a root config is left alone, a legacy config is moved up to
 * the root, and a project with neither gets one written. "stop" is returned
 * for the last case when there was no --url to seed the file with, because a
 * template pointing at localhost:3000 is a placeholder, and running against it
 * would report on whatever happens to answer there.
 */
export async function ensureProjectConfig(opts: EnsureOptions): Promise<"go" | "stop"> {
  if (opts.configPath) return "go";

  const found = locateConfig(opts.cwd);
  if (found && !found.legacy) {
    const stale = legacyConfigIn(found.projectDir);
    if (stale) {
      console.error(
        `lookout: ${stale} is ignored; ${found.path} is the config in use. Delete the old one.`,
      );
    }
    return "go";
  }

  if (found?.legacy) {
    let moved: Migration;
    try {
      moved = await migrateLegacyConfig(found.path);
    } catch (e) {
      // Another run in the same checkout may have moved it between the look
      // and the move. A config at the root is the outcome either way, so only
      // a failure that left none is worth stopping for.
      if (locateConfig(found.projectDir)?.legacy === false) return "go";
      throw e;
    }
    console.error(`lookout: moved ${moved.from} to ${moved.to} (the config lives at the project root now,`);
    console.error("  outside the gitignored .lookout/ directory, so the team can share it).");
    for (const r of moved.rewritten) console.error(`  repointed ${r}`);
    for (const u of moved.unresolved) {
      console.error(`  ${u} is resolved relative to the config file and now points somewhere else; fix it by hand`);
    }
    return "go";
  }

  const root = nearestProjectRoot(opts.cwd);
  if (!root) return "go"; // Not a project: stay zero-config rather than litter.
  const path = await createConfig(root, { url: opts.url });
  if (opts.url) {
    console.error(`lookout: wrote ${path} from --url; the next run reads it and needs no flag.`);
    return "go";
  }
  console.error(`lookout: wrote ${path}`);
  console.error("  edit the target url and routes, then re-run (or pass --url for a one-off run).");
  return "stop";
}
