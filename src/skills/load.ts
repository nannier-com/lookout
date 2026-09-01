/**
 * Skills: lookout's AI capabilities, as versioned instruction files.
 *
 * Every judgement lookout makes is an instruction to a model, and instructions
 * belong in files a person can read and a machine can version, not in string
 * literals compiled into a binary. So each capability (judge, refute,
 * acceptance, fact-check) ships as `skills/<name>/SKILL.md` in the standard
 * Agent Skill layout, and the code supplies only DATA: the shot manifest, the
 * file paths, the question. Nothing in a skill file is computed; nothing in the
 * code tells the model what to think.
 *
 * The prompt shape lives in the skill too, placeholders and all, so changing
 * how a capability is asked never means touching TypeScript.
 *
 * Layering mirrors the rubric idiom this generalises: the shipped file is the
 * base, the project's own `.lookout/skills/<name>/SKILL.md` layers over it, and
 * the composed version is the higher of the two. That version keys the judge
 * ledger, so amending a skill invalidates exactly the cached verdicts it could
 * have changed.
 *
 * The package is installed from npm, so lookout never writes into its own
 * shipped skills: an upgrade would erase them. Everything lookout learns lands
 * in the project's layer, which is the project's to commit.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lookoutDir } from "../config.js";
import { LookoutError, type ResolvedConfig } from "../types.js";

/** The slot every skill must declare, saying where learned rules belong. */
export const AMENDMENT_SLOT = "{{amendments}}";

export interface Skill {
  name: string;
  description: string;
  /** Bumped by any amendment; keys the judge ledger. */
  version: number;
  /** Names the reply contract the caller parses, e.g. "judge-findings-v1". */
  output: string;
  /** Composed instruction text, includes resolved, amendment appended. */
  text: string;
  /** Absolute path of the shipped file, for error messages. */
  path: string;
  /** Absolute path of the project amendment, when one is layered in. */
  amendmentPath: string | null;
}

/** Where the shipped skills live: `skills/` beside `src/` or beside `dist/`. */
export function shippedSkillDir(name: string): string {
  return fileURLToPath(new URL(`../../skills/${name}/`, import.meta.url));
}

/**
 * Skills that have been renamed, retired name -> current name.
 *
 * A skill's name is not only a filename here: it is the directory a project's
 * own amendments live in, and those are the lessons lookout has learned about
 * that project and committed to it. Renaming a shipped skill without this map
 * would leave every one of them in a directory nothing reads again, and the
 * project would quietly go back to judging by the base rubric.
 */
const RENAMED_SKILLS: Record<string, string> = { "visual-judge": "judge-core" };

/**
 * The directory holding a project's layer for a skill: the one named for it, or
 * the one named for whatever it used to be called, when only that exists.
 *
 * Read-only on purpose. Moving the directory would be a write, and the callers
 * here include the page, which is a viewer over what is on disk and must not
 * rewrite the project to render it.
 */
export function projectSkillDir(resolved: ResolvedConfig, name: string): string {
  const root = join(lookoutDir(resolved), "skills");
  const current = join(root, name);
  if (existsSync(current)) return current;
  for (const [retired, renamedTo] of Object.entries(RENAMED_SKILLS)) {
    if (renamedTo !== name) continue;
    const legacy = join(root, retired);
    if (existsSync(legacy)) return legacy;
  }
  return current;
}

/** Where a project's own amendments to a skill live. */
export function projectSkillPath(resolved: ResolvedConfig, name: string): string {
  return join(projectSkillDir(resolved, name), "SKILL.md");
}

/** Where an amendment nothing could grade waits for a person to read it. */
export function projectProposalPath(resolved: ResolvedConfig, name: string): string {
  return join(projectSkillDir(resolved, name), "PROPOSED.md");
}

/**
 * Move a project's layer into the directory the skill is called now.
 *
 * Private to the writer below, which is the only caller and holds the improve
 * lock while it runs, so the rename has a single author. It carries the
 * proposal along with the layer because the whole directory moves, and it is a
 * no-op for a skill that was never renamed or a project already converged.
 */
async function adoptRenamedLayer(resolved: ResolvedConfig, name: string): Promise<void> {
  const inUse = projectSkillDir(resolved, name);
  const current = join(lookoutDir(resolved), "skills", name);
  if (inUse === current) return;
  await rename(inUse, current);
}

/**
 * Write the project's layer for a skill, returning what was there before.
 *
 * Beside the paths rather than beside the amendment logic, because reading the
 * previous layer, adopting a renamed one and writing the new one are all the
 * same question of where this project's copy of a skill lives.
 */
export async function writeLayer(
  resolved: ResolvedConfig,
  name: string,
  body: string,
  version: number,
  description: string,
): Promise<string | null> {
  const before = existsSync(projectSkillPath(resolved, name))
    ? await readFile(projectSkillPath(resolved, name), "utf8")
    : null;
  await adoptRenamedLayer(resolved, name);
  const p = projectSkillPath(resolved, name);
  await mkdir(dirname(p), { recursive: true });
  const front = ["---", `name: ${name}`, `description: ${description}`, `version: ${version}`, "---", ""].join(
    "\n",
  );
  await writeFile(p, `${front}${body.trimEnd()}\n`);
  return before;
}

/** Put back whatever `writeLayer` found, when the gate rejects the candidate. */
export async function restoreLayer(
  resolved: ResolvedConfig,
  name: string,
  before: string | null,
): Promise<void> {
  const p = projectSkillPath(resolved, name);
  if (before === null) await rm(p, { force: true });
  else await writeFile(p, before);
}

interface Parsed {
  fields: Record<string, string>;
  body: string;
}

/**
 * Split `---\nkey: value\n---\n<body>`. Deliberately not a YAML parser: a skill
 * header is four scalar fields, and a dependency that can parse anchors and
 * multi-line flow scalars would be a larger surface than the thing it reads.
 */
function splitFrontmatter(text: string, source: string): Parsed {
  const normalised = text.replace(/^\uFEFF/, "");
  if (!normalised.startsWith("---")) {
    throw new LookoutError(`${source} has no frontmatter block`, "a skill starts with --- name: ... ---");
  }
  const end = normalised.indexOf("\n---", 3);
  if (end === -1) throw new LookoutError(`${source} has an unterminated frontmatter block`);
  const head = normalised.slice(normalised.indexOf("\n") + 1, end);
  const body = normalised.slice(normalised.indexOf("\n", end + 1) + 1);
  const fields: Record<string, string> = {};
  for (const line of head.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) throw new LookoutError(`${source}: frontmatter line is not "key: value": ${line}`);
    fields[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { fields, body: body.trimEnd() };
}

function parseVersionField(value: string | undefined, source: string, required: boolean): number {
  if (value === undefined) {
    if (!required) return 0;
    throw new LookoutError(`${source} has no "version: N" in its frontmatter`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new LookoutError(`${source}: version must be a whole number, got "${value}"`);
  }
  return n;
}

/**
 * Resolve `{{include:file.md}}` against the skill's own directory. Long shared
 * material (the rubric) stays its own file so a person can read and amend it
 * without wading through the invocation wrapper around it.
 */
async function resolveIncludes(body: string, dir: string, source: string): Promise<string> {
  const includes = [...body.matchAll(/\{\{include:([A-Za-z0-9._-]+)\}\}/g)];
  let out = body;
  for (const m of includes) {
    const file = m[1]!;
    const path = join(dir, file);
    if (!existsSync(path)) {
      throw new LookoutError(`${source} includes ${file}, which does not exist`, `looked in ${dir}`);
    }
    out = out.replace(m[0], (await readFile(path, "utf8")).trimEnd());
  }
  return out;
}

/**
 * The shipped skill, with the project's amendment layered over it.
 *
 * Pass null for `resolved` to read the shipped file alone, which is what a test
 * or a `lookout skills` listing wants.
 */
export async function loadSkill(resolved: ResolvedConfig | null, name: string): Promise<Skill> {
  const dir = shippedSkillDir(name);
  const path = join(dir, "SKILL.md");
  if (!existsSync(path)) {
    throw new LookoutError(`no skill named "${name}"`, `expected ${path}`);
  }
  const base = splitFrontmatter(await readFile(path, "utf8"), path);
  let version = parseVersionField(base.fields.version, path, true);
  let text = await resolveIncludes(base.body, dir, path);

  // Where learned rules go is the skill's own decision, declared in the file.
  // Appending them instead would put them after the evidence block in every
  // skill that ends with one, which is where a model stops taking instruction.
  if (!text.includes(AMENDMENT_SLOT)) {
    throw new LookoutError(
      `${path} does not declare ${AMENDMENT_SLOT}`,
      "every skill needs a slot saying where lookout's own amendments belong",
    );
  }

  let amendmentPath: string | null = null;
  let amendments = "";
  if (resolved) {
    const p = projectSkillPath(resolved, name);
    if (existsSync(p)) {
      const amendment = splitFrontmatter(await readFile(p, "utf8"), p);
      version = Math.max(version, parseVersionField(amendment.fields.version, p, false));
      const amendedBody = await resolveIncludes(amendment.body, join(p, ".."), p);
      amendments = `\n## Learned amendments (${resolved.project})\n\n${amendedBody}\n`;
      amendmentPath = p;
    }
  }
  text = fillPlaceholders(text, { amendments });

  return {
    name: base.fields.name ?? name,
    description: base.fields.description ?? "",
    version,
    output: base.fields.output ?? "",
    text,
    path,
    amendmentPath,
  };
}

/**
 * Fill some of a skill's `{{placeholders}}`, leaving the rest for a later
 * layer. The judge fills its project rules here, before the caller fills the
 * manifest, so a project's rules land where the skill says they belong rather
 * than after the evidence.
 */
export function fillPlaceholders(
  text: string,
  vars: Record<string, string | number>,
): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

/**
 * Fill a skill's remaining `{{placeholders}}` and demand that none are left.
 *
 * An unfilled placeholder throws rather than reaching the model: a prompt that
 * says `{{manifest}}` where the screenshots should be would be judged anyway,
 * and the findings would look real.
 */
export function renderSkill(text: string, vars: Record<string, string | number>): string {
  const out = fillPlaceholders(text, vars);
  const leftover = out.match(/\{\{([A-Za-z0-9_:.-]+)\}\}/);
  if (leftover) {
    throw new LookoutError(
      `skill placeholder {{${leftover[1]}}} was never filled`,
      "the skill file asks for data the caller did not pass",
    );
  }
  return out;
}
