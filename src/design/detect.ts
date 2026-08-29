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
 * Everything here is deterministic. No model is asked what the project uses:
 * the manifests say, the directory layout says, and an answer that changes
 * between two runs over the same tree would be worse than no answer at all.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { KNOWN_KITS, TOKEN_MARKERS, type KnownKit } from "./registry.js";
import { readKitExports } from "./exports.js";
import type { DesignInventory, DetectedKit, HandRoll, TokenLayer } from "./inventory.js";
import { nowIso } from "../util.js";
import type { ResolvedConfig } from "../types.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", ".nuxt", ".svelte-kit",
  "coverage", ".lookout", "vendor", "target", "out", ".cache", "storybook-static",
]);

const SOURCE_EXT = /\.(tsx?|jsx?|vue|svelte)$/;

/** Directory names that hold an application's own screens rather than a kit's. */
const APP_DIR_NAMES = ["app", "src/app", "screens", "src/screens", "pages", "src/pages", "views", "src/views", "features", "src/features", "routes", "src/routes"];

interface PackageJson {
  name?: string;
  private?: boolean;
  main?: string;
  module?: string;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function allDeps(pkg: PackageJson | null): Record<string, string> {
  if (!pkg) return {};
  return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
}

/** Every source file under a root, depth-capped, skipping the usual noise. */
async function sourceFiles(root: string, maxDepth = 6): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= maxDepth || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        await walk(p, depth + 1);
      } else if (SOURCE_EXT.test(e.name)) {
        found.push(p);
      }
    }
  };
  await walk(root, 0);
  return found;
}

/** Import specifiers in one file, from both `import ... from "x"` and `require("x")`. */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

/**
 * Workspace globs from whichever manifest declares them. Only the leading
 * directory of each glob is used: resolving `packages/*` properly would mean
 * implementing glob semantics for a result that is always "look in packages".
 */
async function workspaceRoots(repoRoot: string): Promise<string[]> {
  const globs: string[] = [];
  const pkg = await readJson<PackageJson>(join(repoRoot, "package.json"));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws);
  else if (ws?.packages) globs.push(...ws.packages);

  const pnpm = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    const text = await readFile(pnpm, "utf8");
    for (const m of text.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)) globs.push(m[1]!.trim());
  }

  const dirs = new Set<string>();
  for (const g of globs) {
    const head = g.split("/")[0];
    if (head && !head.includes("*")) dirs.add(join(repoRoot, head));
  }
  return [...dirs].filter((d) => existsSync(d));
}

/** Every package inside the workspace, by name, with its root directory. */
async function workspacePackages(repoRoot: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const root of await workspaceRoots(repoRoot)) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const dir = join(root, e.name);
      const pkg = await readJson<PackageJson>(join(dir, "package.json"));
      if (pkg?.name) found.set(pkg.name, dir);
    }
  }
  return found;
}

/**
 * Directories whose NAME says they hold components. Existence is enough for
 * these: nobody calls a directory `atoms` by accident.
 */
const NAMED_COMPONENT_DIRS = [
  "src/atoms", "src/molecules", "src/organisms",
  "src/components", "components", "src/ui", "ui",
];

/**
 * Directories that hold components in some packages and anything at all in the
 * rest. `src` is the whole problem: every workspace package has one, so
 * accepting it on existence would make a design system out of the utility
 * package next door. These have to prove themselves by content.
 */
const MAYBE_COMPONENT_DIRS = ["src/lib", "lib", "src"];

/** A file named like a component: PascalCase, in a language that has them. */
function looksLikeComponentFile(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*\.(tsx|jsx|vue|svelte|ts|js)$/.test(name);
}

/**
 * True when a directory's own files look like a component library rather than
 * like a module. Two is the threshold on purpose: one PascalCase file is a
 * class or a type, and a design system with a single component is not one.
 */
async function holdsComponents(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && looksLikeComponentFile(e.name));
    return files.length >= 2;
  } catch {
    return false;
  }
}

/** Where a package keeps its components, checked rather than assumed. */
async function componentRootsIn(packageRoot: string): Promise<string[]> {
  const named: string[] = [];
  for (const rel of NAMED_COMPONENT_DIRS) {
    const p = join(packageRoot, rel);
    try {
      if ((await stat(p)).isDirectory()) named.push(p);
    } catch {
      continue;
    }
  }
  // A kit that organises by atomic design names all three; returning `src` as
  // well would point a fix at the parent of the thing that is wrong.
  const atomic = named.filter((f) => /\/(atoms|molecules|organisms)$/.test(f));
  if (atomic.length > 0) return atomic;
  if (named.length > 0) return named.slice(0, 1);

  for (const rel of MAYBE_COMPONENT_DIRS) {
    const p = join(packageRoot, rel);
    if (await holdsComponents(p)) return [p];
  }
  return [];
}

/**
 * The project IS the design system.
 *
 * A kit's own repository is the case every signal above misses: nothing depends
 * on it, no marker file names it, and it is not a package inside somebody
 * else's workspace. It is the kit, and a defect found in its own docs or
 * example app belongs in `src/atoms` rather than wherever the defect was
 * photographed. For the maintainers of a design system this is the only case
 * that ever applies, so missing it would make the whole verb useless to them.
 *
 * The discriminator against an ordinary application that happens to have a
 * `components` directory is publication: a library declares an entry point for
 * consumers (`main`, `module`, or `exports`) and an application does not.
 */
async function selfKit(projectDir: string, pkg: PackageJson | null): Promise<DetectedKit | null> {
  if (!pkg?.name || pkg.private === true) return null;
  const publishes = !!(pkg.main ?? pkg.module ?? pkg.exports);
  const roots = await componentRootsIn(projectDir);
  if (roots.length === 0) return null;
  const atomic = roots.some((r) => /\/(atoms|molecules|organisms)$/.test(r));
  if (!publishes && !atomic) return null;
  return {
    id: pkg.name,
    name: pkg.name,
    via: "marker",
    evidence: [
      `this repository is the kit: package ${pkg.name} publishes components from ${roots.join(", ")}`,
    ],
    editable: true,
    packageRoot: projectDir,
    componentRoots: roots,
    importPrefixes: [pkg.name],
    exports: [],
  };
}

/**
 * A design system that lives in this repository but is nobody's published
 * package: a `packages/ui` the apps import. Found by asking which workspace
 * package the application source actually imports from, which is a stronger
 * signal than any name convention, and the only one that works when the kit is
 * called something unguessable.
 */
async function localKits(
  repoRoot: string,
  appImports: Map<string, number>,
): Promise<DetectedKit[]> {
  const packages = await workspacePackages(repoRoot);
  const kits: DetectedKit[] = [];
  for (const [name, dir] of packages) {
    const uses = appImports.get(name) ?? 0;
    if (uses === 0) continue;
    const roots = await componentRootsIn(dir);
    if (roots.length === 0) continue;
    kits.push({
      id: name,
      name,
      via: "inferred",
      evidence: [`workspace package ${name} at ${dir}, imported ${uses} time(s) by application source`],
      editable: true,
      packageRoot: dir,
      componentRoots: roots,
      importPrefixes: [name],
      exports: [],
    });
  }
  // Most-imported first: with two local packages, the one the app leans on is
  // the design system and the other is probably utilities.
  return kits.sort((a, b) => (appImports.get(b.id) ?? 0) - (appImports.get(a.id) ?? 0));
}

/** A vendored kit's component directory, when the marker file promised one. */
async function vendoredRoots(repoRoot: string, kit: KnownKit): Promise<string[]> {
  const found: string[] = [];
  for (const rel of kit.vendoredAt ?? []) {
    const p = join(repoRoot, rel);
    try {
      if ((await stat(p)).isDirectory()) found.push(p);
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Components the application built out of raw elements, in a project that has a
 * kit to build them from.
 *
 * This is a suspicion, deliberately narrow. It fires on a named component
 * declaration whose body is raw primitives and whose name matches something a
 * design system is expected to own. It does NOT fire on layout scaffolding, on
 * anything importing from the kit already, or on files under the kit itself,
 * because a kit is made of raw elements by definition and flagging it would be
 * flagging the design system for existing.
 */
const CONTROL_NAMES = [
  "Button", "Input", "TextField", "Select", "Checkbox", "Radio", "Switch", "Toggle",
  "Modal", "Dialog", "Tooltip", "Badge", "Chip", "Tag", "Card", "Avatar", "Alert",
  "Banner", "Spinner", "Loader", "Tabs", "Accordion", "Dropdown", "Menu", "Slider",
  "Toast", "Breadcrumb", "Pagination", "Table", "Progress",
];

const RAW_ELEMENTS = /<(div|span|button|input|select|textarea|label|a|ul|li|p|h[1-6])[\s/>]/g;

/**
 * The kit component a hand-rolled control duplicates, when the kit provides
 * one.
 *
 * Two answers, and the difference between them is the whole reason the kit is
 * read rather than assumed. `Button` means the kit ships one and the
 * application built a second: a duplicate. `null` means the kit was readable
 * and has nothing like it: still a defect, because a control assembled out of
 * raw elements beside a design system is a gap in that design system, but a
 * different one, and saying "the kit provides Button" about a kit that does not
 * would send somebody looking for an export that was never there.
 *
 * When the kit could not be read at all, the name match is the only evidence
 * available and it is used, because a suspicion is what this scan produces.
 */
export function kitEquivalent(symbol: string, kits: DetectedKit[]): string | null {
  const control = CONTROL_NAMES.find((c) => symbol === c || symbol.endsWith(c));
  if (!control) return null;
  const known = kits.flatMap((k) => k.exports);
  if (known.length === 0) return control;
  return known.find((e) => e === control) ?? null;
}

export async function scanHandRolls(
  appRoots: string[],
  kits: DetectedKit[],
  repoRoot: string,
): Promise<HandRoll[]> {
  if (kits.length === 0) return [];
  // What counts as "inside the kit", and therefore off limits.
  //
  // Component roots always. The package root only when it is a real package
  // boundary BELOW the repository: in a design system's own repository the
  // package root IS the repository, so excluding it would exclude everything
  // and silently disable the scan in the one case it matters most. A kit's own
  // docs or example app hand-rolling a control it ships is a genuine defect,
  // and it lives under that same package root.
  const kitRoots = kits
    .flatMap((k) => [...(k.packageRoot && k.packageRoot !== repoRoot ? [k.packageRoot] : []), ...k.componentRoots])
    .filter((p): p is string => !!p);
  const prefixes = kits.flatMap((k) => k.importPrefixes);
  const out: HandRoll[] = [];

  for (const root of appRoots) {
    for (const file of await sourceFiles(root)) {
      // Never flag the kit's own source. It is raw elements all the way down;
      // that is what a design system is.
      if (kitRoots.some((r) => file.startsWith(r + "/") || file === r)) continue;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const imports = importsOf(text);
      const usesKit = imports.some((i) => prefixes.some((p) => i === p || i.startsWith(p)));

      // A component that already imports the kit is composing it, which is
      // exactly what an app is supposed to do. Only a control built from raw
      // elements with no kit import in the file is a suspected duplicate.
      if (usesKit) continue;

      // Every declaration in the file, so each one's body can be bounded by the
      // start of the next. Slicing to end-of-file instead would credit the
      // first component in a file with every element in the ones below it, and
      // the finding would name elements the component does not contain.
      const decls = [
        ...text.matchAll(/(?:export\s+)?(?:default\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9]*)/g),
      ];
      for (const [i, m] of decls.entries()) {
        const symbol = m[1]!;
        // Named like a control the kit is expected to own. Whether the kit
        // actually owns it is a separate question, answered below.
        if (!CONTROL_NAMES.some((c) => symbol === c || symbol.endsWith(c))) continue;
        const control = kitEquivalent(symbol, kits);
        const start = m.index ?? 0;
        const end = decls[i + 1]?.index ?? text.length;
        const body = text.slice(start, end);
        const raw = [...body.matchAll(RAW_ELEMENTS)].map((r) => r[1]!);
        if (raw.length === 0) continue;
        out.push({
          path: file,
          relPath: relative(repoRoot, file),
          symbol,
          elements: [...new Set(raw)].slice(0, 6),
          candidate: control,
          line: text.slice(0, start).split("\n").length,
          foundBy: "scan",
        });
      }
    }
  }
  return out;
}

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
      "No design system detected. Either this project does not use one, or it uses an in-house kit with no dependency, marker file, or workspace package to name it. Declare it in .lookout/config.ts as `designSystem` if the scan is wrong.",
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
