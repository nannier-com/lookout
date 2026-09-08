/**
 * lookout's own config file, written by lookout.
 *
 * `lookout.config.ts` is lookout's file in someone else's repository, so
 * lookout keeps it: it writes one when a run needs a config and the project has
 * none, and it moves the pre-root `.lookout/config.*` up to the root the first
 * time a run finds one there. Nothing here ever overwrites a config that
 * already exists, and every write says on stderr what it did and where.
 *
 * The move is the part that has to be careful. `rubric`, `direction.file` and a
 * route's `design` are resolved relative to the config file, so a file that changes directory
 * takes those references with it; migration rewrites each one that pointed
 * inside `.lookout/` and names any it could not rewrite by hand.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  CONFIG_FILENAME,
  LEGACY_BASENAMES,
  LOOKOUT_DIR,
  locateConfig,
  nearestProjectRoot,
} from "./config-locate.js";
import {
  DEFAULT_VIEWPORTS,
  DIRECTION_PRESETS,
  FORM_FACTORS,
  LookoutError,
  type LookoutConfig,
} from "./types.js";

/** What a written config should point at, when lookout already knows. */
export interface ConfigSeed {
  /** Base URL from --url: the run that prompted the write. */
  url?: string;
  /** Dev command for `startHint`; `createConfig` derives it from the lockfile. */
  devCommand?: string;
}

/**
 * The dev command the project's lockfile implies. The lockfile is a fact
 * about which package manager the project uses; without one there is no
 * basis to name any, and npm is the ecosystem default, not a preference.
 */
export function devCommandFor(projectDir: string): string {
  if (["bun.lock", "bun.lockb"].some((f) => existsSync(join(projectDir, f)))) return "bun run dev";
  if (existsSync(join(projectDir, "pnpm-lock.yaml"))) return "pnpm dev";
  if (existsSync(join(projectDir, "yarn.lock"))) return "yarn dev";
  return "npm run dev";
}

export function configTemplate(seed: ConfigSeed = {}): string {
  const url = seed.url ?? "http://localhost:3000";
  const dev = seed.devCommand ?? "npm run dev";
  const startHint = seed.url
    ? `      // startHint: "${dev}",   // printed when this target is down\n`
    : `      startHint: "${dev}",\n`;
  const presets = FORM_FACTORS.map((f) => `${f} ${DEFAULT_VIEWPORTS[f].width}x${DEFAULT_VIEWPORTS[f].height}`).join(", ");
  return `import type { LookoutConfig } from "@nannier-com/lookout";

// lookout project config. Targets are the apps this repo renders; lookout
// captures them, judges them, and tracks findings in .lookout/backlog.json.
// lookout writes and maintains this file; it belongs at the project root and
// in git, while everything under .lookout/ is per-checkout state: the
// screenshots, the reports, the run log, and what went wrong with lookout
// itself while it was looking at this project.
// lookout never starts services: startHint is what it prints when one is down.
const config: LookoutConfig = {
  targets: [
    {
      name: "app",
      url: "${url}",
${startHint}      routes: ["/"],
    },
  ],

  // Form factors. Every run photographs each route at desktop, tablet and
  // phone (presets ${presets}, in CSS pixels at 2x); --viewports narrows a
  // run. Resize a preset by key; one you leave out keeps its default. There
  // is no adding or removing one.
  // viewports: { phone: { width: 375, height: 812 } },

  // How this app switches dark/light. "emulate" (default) uses the browser's
  // prefers-color-scheme; use "url-param" when the app reads a query param, or
  // "recipe" and export setScheme(page, scheme) for click choreography.
  // scheme: { mode: "emulate" },

  // Which schemes this app actually ships. Left out, both are photographed,
  // because a project that has not said cannot be assumed to have one. Say so
  // if it ships one: it halves the shots, and stops two identical captures
  // reading as a broken scheme switch.
  // schemes: ["dark"],

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

  // Navigation discovery: lookout enumerates each route's buttons, links, and
  // CTAs, an AI planner curates them, and check captures the resulting states.
  // WARNING: when enabled, lookout clicks everything by default, destructive
  // controls included; point targets at a disposable environment and list
  // anything untouchable in exclude.
  // navigation: {
  //   enabled: true,
  //   maxStatesPerRoute: 5,     // judged interaction states per route
  //   maxChecksPerRoute: 8,     // link verification clicks (no judging cost)
  //   exclude: ["Sign out"],    // selectors or accessible-name substrings
  // },

  // A native or React Native app. Declaring a platform here puts the project
  // in the device fold: every run photographs its booted devices, one phone
  // and one tablet, each needing the app installed. lookout never boots a
  // simulator or installs an app; startHint is what it prints, in your words,
  // when a required device is missing.
  // native: {
  //   ios: { deepLinkScheme: "myapp", bundleId: "com.example.myapp", devices: ["phone"], startHint: "make ios-sim" },
  //   android: { deepLinkScheme: "myapp", bundleId: "com.example.myapp" },
  // },
  // Which fold to judge in, when the repository should not decide:
  // platforms: ["web"],

  // Project-specific judging rules, relative to this file.
  // rubric: "./rubric.md",
  // neverFile: ["the marketing hero intentionally overflows on phone"],

  // The design direction this project chose. The taste panel judges against it
  // instead of against defaults, and what it declares is never filed: a shipped
  // preset, your own DESIGN.md (the first 12 KB reach the judge, so keep the
  // rules above the token tables), or both. The presets that ship:
  //   ${DIRECTION_PRESETS.join(", ")}
  // direction: { preset: "minimalist-editorial" },
  // direction: { file: "./DESIGN.md" },

  // Knobs for the checks that lookout MEASURES, as opposed to the rules above,
  // which are written for the judges. A measurement is never suppressed by a
  // neverFile line, so anything that renders outside its box on purpose (a
  // carousel track, a marquee) is named here instead.
  // checks: { edgeClip: { ignore: [".carousel__track"] } },
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
    await writeFile(path, configTemplate({ devCommand: devCommandFor(projectDir), ...seed }));
  } catch (e) {
    throw new LookoutError(
      `could not write ${path}: ${(e as Error).message}`,
      "write it by hand, or run from a directory lookout can write to",
    );
  }
  return path;
}

/**
 * Keep `.lookout/` out of git, creating the `.gitignore` when there is none.
 *
 * Beside the config writer rather than in `init`, because the ignore line is
 * part of writing a config: a project configured by `--url` on a first run
 * never runs `init`, and its `.lookout/` holds screenshots. Creating the file
 * is the change of posture the workspace's move earned: printing a note was
 * fair when the ignored directory held text, and is not now that a capture
 * puts megabytes of PNGs in the working tree.
 */
export async function ensureIgnored(root: string): Promise<void> {
  const gitignore = join(root, ".gitignore");
  const line = `${LOOKOUT_DIR}/`;
  const block =
    "# lookout working state (backlog, issue folders, screenshots; per-checkout).\n" +
    `# lookout.config.ts is not here on purpose: it is the project's to commit.\n${line}\n`;
  try {
    if (!existsSync(gitignore)) {
      await writeFile(gitignore, block);
      console.error(`lookout: wrote ${gitignore} ignoring ${line}`);
      return;
    }
    const current = await readFile(gitignore, "utf8");
    if (current.split("\n").some((l) => l.trim() === line)) return;
    await appendFile(gitignore, `${current.endsWith("\n") ? "" : "\n"}\n${block}`);
    console.error(`lookout: added ${line} to ${gitignore}`);
  } catch {
    // An unwritable .gitignore is the project's business, not a reason to fail
    // the run that was going to write a config.
  }
}

/** What a directory resolves to: its config, found or freshly written. */
export interface LocatedOrCreated {
  configPath: string;
  projectDir: string;
  /** True when nothing was there and this call wrote the config. */
  created: boolean;
}

/**
 * The config a directory should be served with: the nearest one up its own
 * tree, or a fresh one written at the nearest project root. Null when the
 * directory is not a project at all, so the caller knows to refuse rather
 * than litter.
 *
 * One decision, two callers: `lookout ui` makes it at startup
 * (`projectToServe`) and the settings panel makes it again whenever it is
 * pointed somewhere else at runtime. Both are the screen a project gets
 * configured ON, so both create rather than refuse a directory for want of a
 * config that is not there yet.
 */
export async function locateOrCreateConfig(dir: string): Promise<LocatedOrCreated | null> {
  const located = locateConfig(dir);
  if (located) return { configPath: located.path, projectDir: located.projectDir, created: false };
  const root = nearestProjectRoot(dir);
  if (!root) return null;
  const configPath = await createConfig(root, {});
  await ensureIgnored(root);
  return { configPath, projectDir: root, created: true };
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

/** Every config-relative path a config declares: the rubric, the direction file, and route hand-offs. */
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
  if (typeof config.direction === "object" && config.direction.file) refs.push(config.direction.file);
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
  await ensureIgnored(root);
  if (opts.url) {
    console.error(`lookout: wrote ${path} from --url; the next run reads it and needs no flag.`);
    return "go";
  }
  console.error(`lookout: wrote ${path}`);
  console.error("  edit the target url and routes, then re-run (or pass --url for a one-off run).");
  return "stop";
}
