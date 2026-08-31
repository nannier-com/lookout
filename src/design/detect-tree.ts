/**
 * Reading the repository as a directory tree.
 *
 * The bottom of detection: what files are there, what do they import, and where
 * does this checkout begin. Nothing here knows what a design system is. It is
 * separate because everything above it asks the same handful of questions of
 * the disk, and because a walk that is wrong in one place should be wrong in
 * exactly one place.
 *
 * Every walk is depth-capped and skips the usual noise. A detection pass that
 * descends into node_modules is not slow, it is stopped.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", ".nuxt", ".svelte-kit",
  "coverage", ".lookout", "vendor", "target", "out", ".cache", "storybook-static",
]);

const SOURCE_EXT = /\.(tsx?|jsx?|vue|svelte)$/;


export interface PackageJson {
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

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function allDeps(pkg: PackageJson | null): Record<string, string> {
  if (!pkg) return {};
  return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
}

/** Every source file under a root, depth-capped, skipping the usual noise. */
export async function sourceFiles(root: string, maxDepth = 6): Promise<string[]> {
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

/**
 * Every source file under the application's own roots.
 *
 * Exported because the conformance sweep chooses which of these are worth a
 * model's attention, and it must be choosing from the same set the scan read.
 * Two different notions of "the application's source" would mean a file the
 * scan cleared could never be re-examined, or a file nobody scanned could be
 * filed against.
 */
export async function appSourceFiles(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) out.push(...(await sourceFiles(root)));
  return [...new Set(out)];
}

/** Import specifiers in one file, from both `import ... from "x"` and `require("x")`. */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}
