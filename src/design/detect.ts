/**
 * Working out what a project is built from, by reading it.
 *
 * The question lookout has to answer is not "which library is installed" but
 * "where does a visual fix belong". Those differ in the case that matters most:
 * a monorepo whose apps consume a kit that lives three directories away, where
 * the defect is on a screen and the fix is in a package. So detection resolves
 * the kit to a PATH wherever it can, and records whether that path is inside
 * this repository, because that is what decides who edits it.
 *
 * This file is the pass itself: find the application's own source, ask the
 * three modules beside it what they know, and assemble one inventory.
 * `detect-tree` reads the directory tree, `detect-kits` resolves the kit four
 * ways, and `detect-handrolls` looks for controls the app built for itself.
 *
 * Everything here is deterministic. No model is asked what the project uses:
 * the manifests say, the directory layout says, and an answer that changes
 * between two runs over the same tree would be worse than no answer at all.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { KNOWN_KITS, TOKEN_MARKERS } from "./registry.js";
import { readKitExports } from "./exports.js";
import {
  SKIP_DIRS,
  allDeps,
  importsOf,
  readJson,
  sourceFiles,
  type PackageJson,
} from "./detect-tree.js";
import { localKits, selfKit, vendoredRoots } from "./detect-kits.js";
import { scanHandRolls } from "./detect-handrolls.js";
import type { DesignInventory, DetectedKit, TokenLayer } from "./inventory.js";
import { nowIso } from "../util.js";
import type { ResolvedConfig } from "../types.js";

/** Directory names that hold an application's own screens rather than a kit's. */
const APP_DIR_NAMES = ["app", "src/app", "screens", "src/screens", "pages", "src/pages", "views", "src/views", "features", "src/features", "routes", "src/routes"];

/**
 * Applications that live beside the thing being scanned: a docs site, an
 * example, a playground, an app inside a monorepo.
 *
 * A design system's own repository is the case this exists for. Its `src` is
 * the kit and is exempt from the hand-roll scan by definition, so without this
 * there is nothing left to scan and the most valuable finding available (the
 * kit's own docs app hand-rolling a control the kit ships) is unreachable.
 *
 * The rule is structural rather than a list of blessed directory names: a
 * directory with its own package.json is its own application. That covers
 * `docs`, `example`, `playground` and `apps/web` without having to guess which
 * of them a given project happens to use.
 */
async function siblingApps(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(repoRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const dir = join(repoRoot, e.name);
    if (!existsSync(join(dir, "package.json"))) continue;
    // Scan its source, not its whole tree: the root of an app holds config,
    // lockfiles and build output that the walk would otherwise wade through.
    const src = join(dir, "src");
    found.push(existsSync(src) ? src : dir);
  }
  return found;
}

/** Directories holding the application's own screens, as opposed to a kit's. */
async function appSourceRoots(projectDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of APP_DIR_NAMES) {
    const p = join(projectDir, rel);
    try {
      if ((await stat(p)).isDirectory()) found.push(p);
    } catch {
      continue;
    }
  }
  found.push(...(await siblingApps(projectDir)));
  if (found.length > 0) return [...new Set(found)];
  const src = join(projectDir, "src");
  return existsSync(src) ? [src] : [projectDir];
}

/** The repository root: the nearest ancestor holding a .git, else the project. */
export async function repoRootOf(projectDir: string): Promise<string> {
  let cur = resolve(projectDir);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(projectDir);
}

export interface DetectOptions {
  /** Skip the hand-roll scan, which is the only expensive part. */
  skipHandRolls?: boolean;
}

/**
 * Read the project and say what it is built from.
 *
 * A declared `designSystem` in the config is not consulted here: this function
 * reports what the repository shows, and the caller layers the declaration over
 * it. Keeping those apart means `--refresh` can show a person that what they
 * declared and what is on disk have come apart.
 */
export async function detect(
  resolved: ResolvedConfig,
  opts: DetectOptions = {},
): Promise<DesignInventory> {
  const { projectDir, project } = resolved;
  const repoRoot = await repoRootOf(projectDir);
  const notes: string[] = [];

  const pkg = await readJson<PackageJson>(join(projectDir, "package.json"));
  const rootPkg =
    repoRoot === projectDir ? pkg : await readJson<PackageJson>(join(repoRoot, "package.json"));
  const deps = { ...allDeps(rootPkg), ...allDeps(pkg) };

  const appRoots = await appSourceRoots(projectDir);

  // Import census over the application's own source: it decides which workspace
  // package is the kit, and it is the denominator for the adoption figure.
  const appImports = new Map<string, number>();
  let totalImports = 0;
  for (const root of appRoots) {
    for (const file of await sourceFiles(root)) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const spec of importsOf(text)) {
        if (spec.startsWith(".")) continue;
        totalImports++;
        // Count both the full specifier and its package root, so a deep import
        // of `@nannier/canvas/atoms` still counts toward the kit.
        const scoped = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        appImports.set(scoped, (appImports.get(scoped) ?? 0) + 1);
      }
    }
  }

  const kits: DetectedKit[] = [];
  for (const kit of KNOWN_KITS) {
    const hit = kit.packages.find((p) => p in deps);
    const markers = (kit.markers ?? []).map((m) => join(repoRoot, m)).filter((p) => existsSync(p));
    if (!hit && markers.length === 0) continue;

    const roots = await vendoredRoots(repoRoot, kit);
    // Vendored means the files are here; installed means they are in
    // node_modules and upstream. That single bit decides where a fix goes, so
    // it is derived from whether the components were actually found on disk.
    const editable = roots.length > 0;
    kits.push({
      id: kit.id,
      name: kit.name,
      via: hit ? "dependency" : "marker",
      evidence: [
        ...(hit ? [`dependency ${hit}@${deps[hit]}`] : []),
        ...markers.map((m) => `marker file ${m}`),
      ],
      editable,
      packageRoot: editable ? repoRoot : null,
      componentRoots: roots,
      importPrefixes: kit.importPrefixes ?? kit.packages,
      exports: [],
      ...(kit.docs ? { docs: kit.docs } : {}),
    });
    // First match wins: the registry is ordered so a kit built on a primitive
    // is found before the primitive it is built from.
    break;
  }

  // The repository's own package, when it is itself a design system. It goes
  // FIRST: a kit built on top of another kit (Canvas over Radix, a house kit
  // over MUI) still owns its own components, so the editable in-repo kit is
  // what a fix is aimed at and the upstream one is context.
  const own = await selfKit(projectDir, pkg);
  if (own && !kits.some((k) => k.id === own.id)) kits.unshift(own);

  kits.push(...(await localKits(repoRoot, appImports)));

  // What each kit actually provides, read from the kit. Done once the kit list
  // is settled and before anything asks what a hand-rolled control duplicates,
  // because that question has no honest answer until this is filled in.
  const searchRoots = [...new Set([projectDir, repoRoot])];
  for (const k of kits) {
    k.exports = await readKitExports(k, { searchRoots });
  }

  const tokens: TokenLayer[] = [];
  for (const t of TOKEN_MARKERS) {
    const files = t.files.map((f) => join(repoRoot, f)).filter((p) => existsSync(p));
    if (files.length > 0) tokens.push({ id: t.id, name: t.name, files });
  }

  // Prefix match, not lookup. Registry prefixes are written as "@mui/" while
  // the census keys on "@mui/material", so an exact get would report every MUI
  // application as having adopted nothing.
  const prefixes = kits.flatMap((k) => k.importPrefixes);
  let fromKit = 0;
  for (const [spec, n] of appImports) {
    if (prefixes.some((p) => spec === p || spec.startsWith(p))) fromKit += n;
  }

  const handRolls = opts.skipHandRolls ? [] : await scanHandRolls(appRoots, kits, repoRoot);

  // Adoption is meaningless for a kit's own repository: a design system does
  // not import itself, so the honest figure would be 0% and would read as "this
  // project has not adopted its design system", which is nonsense when the
  // project IS the design system.
  const isOwnKit = kits[0]?.packageRoot === projectDir && kits[0]?.id === pkg?.name;
  const adoption = isOwnKit || totalImports === 0 ? null : { fromKit, total: totalImports };

  if (kits.length === 0) {
    notes.push(
      "No design system detected. Either this project does not use one, or it uses an in-house kit with no dependency, marker file, or workspace package to name it. Declare it in lookout.config.ts as `designSystem` if the scan is wrong.",
    );
  }
  if (kits.length > 0 && fromKit === 0 && !isOwnKit) {
    notes.push(
      `${kits[0]!.name} is installed but the application source imports nothing from it. Either the app has not adopted it yet, or the screens live somewhere the scan did not look (it read ${appRoots.map((r) => basename(r)).join(", ")}).`,
    );
  }

  return {
    schema: 2,
    at: nowIso(),
    project,
    kits,
    tokens,
    appRoots,
    handRolls,
    adoption,
    notes,
  };
}
