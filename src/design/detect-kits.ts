/**
 * Which kit this repository has, and where its components actually are.
 *
 * Four shapes, and the distinction that matters in all of them is whether the
 * kit's source is inside this repository: that is what decides whether a defect
 * in a component is fixed here or upstream. A workspace package the app
 * imports, a kit vendored into the tree, the repository that IS the kit, and
 * the installed dependency that is nobody's to edit here.
 *
 * Deterministic throughout. No model is asked what the project uses: the
 * manifests say, the directory layout says, and an answer that changed between
 * two runs over the same tree would be worse than no answer at all.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SKIP_DIRS, readJson, type PackageJson } from "./detect-tree.js";
import type { KnownKit } from "./registry.js";
import type { DetectedKit } from "./inventory.js";

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
export async function componentRootsIn(packageRoot: string): Promise<string[]> {
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
export async function selfKit(projectDir: string, pkg: PackageJson | null): Promise<DetectedKit | null> {
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
export async function localKits(
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
export async function vendoredRoots(repoRoot: string, kit: KnownKit): Promise<string[]> {
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
