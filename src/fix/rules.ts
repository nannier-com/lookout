/**
 * Project rule discovery.
 *
 * lookout hands work to an agent it did not configure and cannot see the
 * settings of, so it cannot assume the agent's harness will load the project's
 * conventions. A fix session that has not read the repository's rules will
 * cheerfully hand-roll a component the project forbids, or break a convention
 * the whole codebase depends on.
 *
 * Every brief therefore names the rule files that actually exist, by path, and
 * requires them to be read first. Discovery is by filename across the harnesses
 * agents actually use, not just one vendor's, because lookout is meant to be
 * driven by whichever agent the project prefers.
 */
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Rule files, across harnesses. Order is the order a brief lists them in. */
export const RULE_FILENAMES = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  "CONVENTIONS.md",
  ".cursorrules",
  ".windsurfrules",
  ".rules",
] as const;

const NESTED_RULE_PATHS = [
  join(".github", "copilot-instructions.md"),
  join(".cursor", "rules"),
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".lookout",
  "vendor",
  "target",
]);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function inDir(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of RULE_FILENAMES) {
    const p = join(dir, name);
    if (await exists(p)) found.push(p);
  }
  for (const rel of NESTED_RULE_PATHS) {
    const p = join(dir, rel);
    if (await exists(p)) found.push(p);
  }
  return found;
}

/**
 * Rule files governing `projectDir`: the repository's own, any nested ones in
 * the subtree (a package or app inside a monorepo carries its own), and any in
 * ancestor directories, which is where a workspace keeps the rules its members
 * inherit.
 */
export async function discoverRuleFiles(
  projectDir: string,
  opts: { depth?: number; ancestors?: number } = {},
): Promise<string[]> {
  const maxDepth = opts.depth ?? 3;
  const maxAncestors = opts.ancestors ?? 3;
  const found: string[] = [];

  // Ancestors first: a workspace rule is context for the repo rule that follows.
  const ancestry: string[] = [];
  let cur = dirname(projectDir);
  for (let i = 0; i < maxAncestors && cur && cur !== dirname(cur); i++) {
    ancestry.unshift(cur);
    cur = dirname(cur);
  }
  for (const dir of ancestry) found.push(...(await inDir(dir)));

  const walk = async (dir: string, depth: number): Promise<void> => {
    found.push(...(await inDir(dir)));
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(projectDir, 0);

  return [...new Set(found)];
}
