/**
 * What a kit actually provides.
 *
 * Everything downstream of detection wants to say a sentence of the form "the
 * application hand-rolled a thing the kit already ships". That sentence is only
 * worth reading if the second half is true, and until this file existed it was
 * a guess: the scanner matched a component's NAME against a fixed list of
 * control words and reported that the kit "appears to provide" whichever one
 * matched, having never once looked at the kit.
 *
 * So the kit is read. Three sources, best first, and the first that yields
 * anything wins:
 *
 *   1. the component directories detection already resolved, where a file named
 *      `Button.tsx` is a component called Button and the exports inside it are
 *      readable,
 *   2. the package's own barrel, for a kit that re-exports from one index,
 *   3. the installed package's type declarations, for a kit in node_modules,
 *      which is the only source available when the kit is not this repository's.
 *
 * Reading a kit is bounded on purpose. A design system with four hundred
 * exports is not a design system anybody navigates, and an unbounded walk over
 * node_modules is how a fast scan becomes a slow one. Both caps are stated
 * below rather than tuned in a loop.
 *
 * Nothing here is a judgement. An export list is a fact about a package, and a
 * fact lookout can be wrong about only by failing to read it.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DetectedKit } from "./inventory.js";

/** How many exports are worth carrying. Past this the list stops informing anything. */
const MAX_EXPORTS = 300;

/** How many files one kit's scan will open, across every source. */
const MAX_FILES = 400;

/** Bytes of a single declaration file worth parsing; a bundled .d.ts can be enormous. */
const MAX_DECLARATION_BYTES = 4 * 1024 * 1024;

const COMPONENT_FILE = /^([A-Z][A-Za-z0-9]*)\.(tsx|jsx|vue|svelte|ts|js)$/;

/** Files that sit beside components and are not components. */
const NOT_A_COMPONENT = /\.(test|spec|stories|styles|types|constants|utils)\./;

/**
 * A PascalCase name, which is what a component is called in every kit lookout
 * knows about. Hooks, helpers and constants are excluded by the same rule: an
 * application does not hand-roll a duplicate of `useTheme`.
 *
 * The lowercase letter is what separates a component from a constant. Kits
 * export `SPACING` and `BREAKPOINTS` beside their components, and an export
 * list that carries those would have lookout reporting that an application
 * hand-rolled a duplicate of a number.
 */
function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && name.length > 1 && /[a-z]/.test(name);
}

/**
 * Exported symbols in one file of source or declarations.
 *
 * Deliberately regular expressions rather than a parser. The question is "what
 * names does this file expose", the answers are on single lines in every syntax
 * that matters, and a TypeScript program instantiated per kit would cost more
 * than every other part of detection combined.
 */
export function exportedSymbols(text: string): string[] {
  const out: string[] = [];

  // export const X / export function X / export class X, with the `declare`
  // that .d.ts files insert between the two.
  for (const m of text.matchAll(
    /export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g,
  )) {
    out.push(m[1]!);
  }

  // export { A, B as C } and export { A } from "./a"
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const alias = part.split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0] ?? "").trim();
      if (name) out.push(name);
    }
  }

  return out.filter(isComponentName);
}

/** Every file under a root, depth-capped, stopping once the budget is spent. */
async function filesUnder(root: string, budget: { left: number }, maxDepth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (budget.left <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.left <= 0) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= maxDepth || e.name.startsWith(".") || e.name === "node_modules") continue;
        await walk(p, depth + 1);
      } else {
        found.push(p);
        budget.left--;
      }
    }
  };
  await walk(root, 0);
  return found;
}

/** Components named by the kit's own component directories. */
async function fromComponentRoots(roots: string[], budget: { left: number }): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    for (const file of await filesUnder(root, budget)) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      if (NOT_A_COMPONENT.test(base)) continue;
      const named = COMPONENT_FILE.exec(base);
      // The file name is the strongest signal a kit gives: `atoms/Button.tsx`
      // is Button whether or not the export inside it is readable.
      if (named) out.push(named[1]!);
      if (!/\.(tsx?|jsx?)$/.test(base)) continue;
      try {
        out.push(...exportedSymbols(await readFile(file, "utf8")));
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** A kit that re-exports everything from one index. */
async function fromBarrel(packageRoot: string): Promise<string[]> {
  for (const rel of ["src/index.ts", "src/index.tsx", "index.ts", "index.tsx", "src/index.js", "index.js"]) {
    const p = join(packageRoot, rel);
    if (!existsSync(p)) continue;
    try {
      return exportedSymbols(await readFile(p, "utf8"));
    } catch {
      continue;
    }
  }
  return [];
}

interface PackageManifest {
  types?: string;
  typings?: string;
  exports?: Record<string, unknown> | string;
}

/** The type declarations an installed package points at, when it points at any. */
function declarationEntries(manifest: PackageManifest): string[] {
  const out: string[] = [];
  if (manifest.types) out.push(manifest.types);
  if (manifest.typings) out.push(manifest.typings);
  const dot = typeof manifest.exports === "object" ? manifest.exports?.["."] : undefined;
  if (dot && typeof dot === "object") {
    const types = (dot as Record<string, unknown>).types;
    if (typeof types === "string") out.push(types);
    // exports["."] = { import: { types: "..." } } is common enough to be worth
    // one more level; deeper than that and the manifest is describing
    // conditions no reader of this file cares about.
    for (const cond of ["import", "require", "default"]) {
      const nested = (dot as Record<string, unknown>)[cond];
      if (nested && typeof nested === "object") {
        const t = (nested as Record<string, unknown>).types;
        if (typeof t === "string") out.push(t);
      }
    }
  }
  return out;
}

/**
 * A kit that lives in node_modules. Its source is not this repository's to read
 * for anything else, but its declarations are the only honest answer to what it
 * provides, and reading them is what stops lookout inventing a component the
 * kit does not have.
 */
async function fromInstalled(packageName: string, searchRoots: string[]): Promise<string[]> {
  for (const root of searchRoots) {
    const dir = join(root, "node_modules", packageName);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
    } catch {
      continue;
    }
    const out: string[] = [];
    for (const rel of declarationEntries(manifest)) {
      const p = join(dir, rel);
      try {
        if ((await stat(p)).size > MAX_DECLARATION_BYTES) continue;
        out.push(...exportedSymbols(await readFile(p, "utf8")));
      } catch {
        continue;
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

export interface ExportScanOptions {
  /** Roots to look for a node_modules under, nearest first. */
  searchRoots: string[];
}

/**
 * The component names this kit exposes, or an empty list when the kit cannot be
 * read from here.
 *
 * Empty is a real answer and it is treated as one everywhere downstream: an
 * unreadable kit means lookout does not know what the kit provides, which is
 * different from knowing that it provides nothing. Nothing infers absence from
 * this list being empty.
 */
export async function readKitExports(
  kit: DetectedKit,
  opts: ExportScanOptions,
): Promise<string[]> {
  const budget = { left: MAX_FILES };
  const found: string[] = [];

  if (kit.componentRoots.length > 0) {
    found.push(...(await fromComponentRoots(kit.componentRoots, budget)));
  }
  if (found.length === 0 && kit.packageRoot) {
    found.push(...(await fromBarrel(kit.packageRoot)));
  }
  if (found.length === 0) {
    // Every prefix that names a package: a kit split across several packages
    // (`@mui/material` and `@mui/lab`) provides the union of them.
    for (const prefix of kit.importPrefixes) {
      const packageName = prefix.replace(/\/$/, "");
      if (packageName.includes("*")) continue;
      found.push(...(await fromInstalled(packageName, opts.searchRoots)));
      if (found.length > 0) break;
    }
  }

  return [...new Set(found.filter(isComponentName))].sort().slice(0, MAX_EXPORTS);
}
