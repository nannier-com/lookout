/**
 * Rule discovery, global and local.
 *
 * A handoff is opened in an agent lookout did not configure and cannot see the
 * settings of, so it cannot assume that agent's harness will load anything. A
 * session that has not read the rules will cheerfully hand-roll a component the
 * project forbids, or break a convention the whole codebase depends on.
 *
 * So every handoff names the rule files that actually exist, by absolute path:
 * the operator's global ones, then the workspace's, then the repository's.
 * Discovery is by filename across the harnesses agents actually use, not just
 * one vendor's, because a handoff can be opened in any of them.
 */
import { homedir } from "node:os";
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

/**
 * Where each harness keeps the rules that apply to everything the operator does.
 * Claude Code loads its own; the rest do not know about it, and a handoff can be
 * opened in any of them.
 */
const GLOBAL_RULE_PATHS = [
  join(".claude", "CLAUDE.md"),
  join(".config", "claude", "CLAUDE.md"),
  join(".codex", "AGENTS.md"),
  join(".config", "codex", "AGENTS.md"),
  join(".agents", "AGENTS.md"),
  join(".gemini", "GEMINI.md"),
] as const;

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

/** The operator's own rules, which apply whatever repository is open. */
export async function globalRuleFiles(home = homedir()): Promise<string[]> {
  const found: string[] = [];
  for (const rel of GLOBAL_RULE_PATHS) {
    const p = join(home, rel);
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

/**
 * Everything that governs work in this repository, global first, so a session
 * reads the operator's standing rules before the project's own.
 */
export async function allRuleFiles(projectDir: string): Promise<string[]> {
  return [...new Set([...(await globalRuleFiles()), ...(await discoverRuleFiles(projectDir))])];
}
