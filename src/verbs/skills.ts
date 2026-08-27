/**
 * `lookout skills <sub>`: what lookout knows how to judge, and how it learns.
 *
 *   list     the skills, their versions, and which ones this project amends
 *   diff     what this project has added to a skill
 *   freeze   rebuild the frozen regression set from the settled backlog
 *   replay   judge the frozen set with the skills as they stand
 *   improve  read this project's signals, amend a skill, and keep the amendment
 *            only if the frozen set still holds
 *
 * `improve` is the one that writes. It is deliberately not a proposal workflow:
 * an amendment that survives the frozen set is applied, because a gate a human
 * has to walk through every time is a gate that stops being walked. What keeps
 * that safe is that the gate is evidence, not judgement: screenshots whose
 * verdicts were settled when the pixels were fresh, including the ones a person
 * ruled intentional and wrote a reason for.
 */
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, lookoutDir } from "../config.js";
import { loadBacklog } from "./backlog.js";
import { loadRubric } from "../judge/rubric.js";
import { batchShots, extractJson, invokeClaude, judgeBatch, type AiFinding } from "../judge/engine.js";
import { verifyFindings } from "../judge/verify.js";
import { loadSkill, projectSkillPath, renderSkill, type Skill } from "../skills/load.js";
import { bySkill, gatherSignals, type Signal } from "../skills/signals.js";
import {
  casesAsShots,
  evaluateReplay,
  freezeRegressionSet,
  loadRegressionSet,
  regressionDir,
  usableCases,
  type RegressionSet,
  type Violation,
} from "../skills/regression.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { nowIso, printJson, str, type Parsed } from "../util.js";

/** Every skill lookout ships, in the order a run uses them. */
export const SKILL_NAMES = [
  "visual-judge",
  "refute-finding",
  "verify-acceptance",
  "fact-check",
  "improve-skills",
] as const;

/**
 * The skills the frozen set can actually exercise. An amendment to anything
 * else is written down as a proposal rather than applied: auto-applying a
 * change nothing can grade is the exact thing the gate exists to prevent.
 */
const GATED_SKILLS = new Set(["visual-judge", "refute-finding"]);

export function historyPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "skills", "history.jsonl");
}

interface HistoryEntry {
  at: string;
  skill: string;
  action: "applied" | "rolled-back" | "proposed" | "no-change";
  summary: string;
  version?: number;
  evidence?: string[];
  violations?: Violation[];
}

async function record(resolved: ResolvedConfig, entry: HistoryEntry): Promise<void> {
  const p = historyPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(entry) + "\n");
}

/** Judge the frozen set as the skills currently stand, and see what breaks. */
export async function replayRegression(
  resolved: ResolvedConfig,
  set: RegressionSet,
  model: string,
): Promise<{ violations: Violation[]; findings: AiFinding[]; costUsd: number }> {
  const usable = { ...set, cases: usableCases(resolved, set) };
  if (usable.cases.length === 0) {
    throw new LookoutError(
      set.cases.length === 0
        ? "the frozen regression set is empty"
        : "the frozen screenshots are not on this machine",
      "run `lookout skills freeze` (the manifest is committed; the pixels are rebuilt from evidence)",
    );
  }
  const dir = regressionDir(resolved);
  const shots = casesAsShots(usable);
  const rubric = await loadRubric(resolved);
  const refute = await loadSkill(resolved, "refute-finding");

  let costUsd = 0;
  const raw: AiFinding[] = [];
  for (const batch of batchShots(shots)) {
    const res = await judgeBatch(rubric.text, resolved.project, batch, dir, model);
    costUsd += res.costUsd ?? 0;
    raw.push(...res.findings);
  }

  // The pipeline as it actually runs: the refuter gets to kill findings before
  // anything is filed, so an amendment to it is gated the same way.
  const shotsById = new Map(shots.map((s) => [s.id, s]));
  let findings = raw;
  if (raw.length > 0) {
    const verified = await verifyFindings(refute.text, raw, shotsById, dir, model);
    costUsd += verified.costUsd ?? 0;
    findings = verified.confirmed;
  }

  return { violations: evaluateReplay(usable, findings), findings, costUsd };
}

interface Amendment {
  skill: string;
  summary: string;
  amendment: string;
  evidence: string[];
  newSkill: { name: string; description: string; body: string } | null;
}

function describeSkills(list: Skill[]): string {
  return list
    .map((s) => `- ${s.name} (v${s.version})${s.amendmentPath ? " [already amended here]" : ""}: ${s.description}`)
    .join("\n");
}

function describeSignals(signals: Signal[]): string {
  return signals
    .map((s, i) => `${i + 1}. [${s.kind}] ${s.summary}\n   why: ${s.detail}\n   source: ${s.source}`)
    .join("\n");
}

async function askForAmendment(
  resolved: ResolvedConfig,
  signals: Signal[],
  model: string,
): Promise<{ amendment: Amendment; costUsd: number }> {
  const skill = await loadSkill(resolved, "improve-skills");
  const known = await Promise.all(SKILL_NAMES.map((n) => loadSkill(resolved, n)));
  const prompt = renderSkill(skill.text, {
    project: resolved.project,
    skills: describeSkills(known),
    signals: describeSignals(signals),
  });
  const res = await invokeClaude({ prompt, cwd: lookoutDir(resolved), model });
  const parsed = extractJson(res.text) as Partial<Amendment>;
  const name = String(parsed.skill ?? "");
  if (!SKILL_NAMES.includes(name as (typeof SKILL_NAMES)[number]) && !parsed.newSkill) {
    throw new LookoutError(`the amendment names an unknown skill "${name}"`);
  }
  return {
    amendment: {
      skill: name,
      summary: String(parsed.summary ?? "").slice(0, 400),
      amendment: String(parsed.amendment ?? "").trim(),
      evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).map(String),
      newSkill: parsed.newSkill ?? null,
    },
    costUsd: res.costUsd ?? 0,
  };
}

/** Write the project's layer for a skill, returning what was there before. */
async function writeLayer(
  resolved: ResolvedConfig,
  name: string,
  body: string,
  version: number,
  description: string,
): Promise<string | null> {
  const p = projectSkillPath(resolved, name);
  const before = existsSync(p) ? await readFile(p, "utf8") : null;
  await mkdir(dirname(p), { recursive: true });
  const front = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `version: ${version}`,
    "---",
    "",
  ].join("\n");
  await writeFile(p, `${front}${body.trimEnd()}\n`);
  return before;
}

async function restoreLayer(resolved: ResolvedConfig, name: string, before: string | null): Promise<void> {
  const p = projectSkillPath(resolved, name);
  if (before === null) await rm(p, { force: true });
  else await writeFile(p, before);
}

export async function skills(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0] ?? "list";
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
  });
  const model = str(parsed.flags.model) ?? "sonnet";

  if (sub === "list") {
    const list = await Promise.all(SKILL_NAMES.map((n) => loadSkill(resolved, n)));
    if (parsed.flags.json) {
      printJson(
        list.map((s) => ({
          name: s.name,
          version: s.version,
          description: s.description,
          shipped: s.path,
          amendment: s.amendmentPath,
        })),
      );
      return 0;
    }
    for (const s of list) {
      console.log(`  ${s.name.padEnd(20)} v${String(s.version).padEnd(4)} ${s.description}`);
      if (s.amendmentPath) console.log(`  ${" ".repeat(20)}      amended here: ${s.amendmentPath}`);
    }
    return 0;
  }

  if (sub === "diff") {
    const name = parsed.positionals[1];
    if (!name) throw new LookoutError("diff needs a skill name", `one of: ${SKILL_NAMES.join(", ")}`);
    const p = projectSkillPath(resolved, name);
    if (!existsSync(p)) {
      console.log(`${name}: this project has not amended it`);
      return 0;
    }
    console.log(await readFile(p, "utf8"));
    return 0;
  }

  if (sub === "freeze") {
    const backlog = await loadBacklog(resolved);
    const set = await freezeRegressionSet(resolved, backlog, nowIso());
    const claims = set.cases.reduce((n, c) => n + c.mustFile.length + c.mustNotFile.length, 0);
    console.log(
      `froze ${set.cases.length} screenshot(s) carrying ${claims} settled claim(s) ` +
        `into ${regressionDir(resolved)}`,
    );
    if (set.cases.length === 0) {
      console.log("  nothing settled yet: adjudicate findings (by-design, or verified) first.");
    }
    return 0;
  }

  if (sub === "replay") {
    const set = await loadRegressionSet(resolved);
    if (!set) throw new LookoutError("no frozen set", "run `lookout skills freeze` first");
    const { violations, costUsd } = await replayRegression(resolved, set, model);
    if (parsed.flags.json) {
      printJson({ ok: violations.length === 0, cases: set.cases.length, violations, costUsd });
    } else if (violations.length === 0) {
      console.log(`replay: clean over ${set.cases.length} frozen screenshot(s) ($${costUsd.toFixed(3)})`);
    } else {
      for (const v of violations) {
        console.log(`  [${v.kind}] ${v.shotId} ${v.category}\n      ${v.why}`);
      }
      console.log(`\n${violations.length} violation(s).`);
    }
    return violations.length === 0 ? 0 : 1;
  }

  if (sub === "improve") {
    const signals = await gatherSignals(resolved);
    if (signals.length === 0) {
      console.log("nothing to learn from yet: no refutations, adjudications or blocked issues on record.");
      return 0;
    }
    const grouped = bySkill(signals);
    console.log(
      `${signals.length} signal(s) across ${grouped.size} skill(s): ` +
        [...grouped].map(([name, s]) => `${name} ${s.length}`).join(", "),
    );

    // The gate first: an amendment written with nothing able to grade it is not
    // applied, so there is no point asking for one until this is known.
    let set = await loadRegressionSet(resolved);
    if (!set) {
      const backlog = await loadBacklog(resolved);
      set = await freezeRegressionSet(resolved, backlog, nowIso());
    }

    const { amendment, costUsd } = await askForAmendment(resolved, signals, model);

    if (amendment.newSkill) {
      const { name, description, body } = amendment.newSkill;
      // lookout owns the frontmatter and the amendment slot, so a skill it
      // writes is always one it can load and later amend.
      await writeLayer(resolved, name, `${body.trimEnd()}\n\n{{amendments}}\n`, 1, description);
      await record(resolved, {
        at: nowIso(),
        skill: name,
        action: "proposed",
        summary: amendment.summary,
        evidence: amendment.evidence,
      });
      console.log(`new skill written: ${projectSkillPath(resolved, name)}`);
      console.log(`  ${amendment.summary}`);
      console.log("  nothing invokes it yet: wiring a new capability to a verb is a code change.");
      return 0;
    }

    if (!amendment.amendment) {
      await record(resolved, {
        at: nowIso(),
        skill: amendment.skill,
        action: "no-change",
        summary: amendment.summary,
      });
      console.log(`no amendment warranted: ${amendment.summary}`);
      return 0;
    }

    const current = await loadSkill(resolved, amendment.skill);
    const existingBody = current.amendmentPath
      ? (await readFile(current.amendmentPath, "utf8")).replace(/^---[\s\S]*?\n---\n/, "")
      : "";
    const nextVersion = current.version + 1;
    const merged = `${existingBody.trimEnd()}\n\n## ${nowIso().slice(0, 10)}: ${amendment.summary}\n\n${amendment.amendment}\n`;

    const gradeable = usableCases(resolved, set).length;
    if (!GATED_SKILLS.has(amendment.skill) || gradeable === 0) {
      const why =
        gradeable === 0
          ? "there is nothing frozen to grade this against (run `lookout skills freeze`)"
          : `the frozen set cannot exercise ${amendment.skill}`;
      const p = join(lookoutDir(resolved), "skills", amendment.skill, "PROPOSED.md");
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, merged);
      await record(resolved, {
        at: nowIso(),
        skill: amendment.skill,
        action: "proposed",
        summary: amendment.summary,
        evidence: amendment.evidence,
      });
      console.log(`proposed, not applied: ${why}.`);
      console.log(`  ${p}`);
      return 0;
    }

    const before = await writeLayer(
      resolved,
      amendment.skill,
      merged,
      nextVersion,
      `${resolved.project}'s own rules for ${amendment.skill}`,
    );

    console.log(`replaying ${gradeable} frozen screenshot(s) against the candidate...`);
    let violations: Violation[];
    let replayCost = 0;
    try {
      const outcome = await replayRegression(resolved, set, model);
      violations = outcome.violations;
      replayCost = outcome.costUsd;
    } catch (e) {
      await restoreLayer(resolved, amendment.skill, before);
      throw new LookoutError(
        `the replay could not run, so the amendment was rolled back: ${(e as Error).message}`,
      );
    }

    if (violations.length > 0) {
      await restoreLayer(resolved, amendment.skill, before);
      await record(resolved, {
        at: nowIso(),
        skill: amendment.skill,
        action: "rolled-back",
        summary: amendment.summary,
        evidence: amendment.evidence,
        violations,
      });
      console.log(`rolled back: the candidate broke ${violations.length} settled verdict(s).`);
      for (const v of violations) console.log(`  [${v.kind}] ${v.shotId} ${v.category}: ${v.why}`);
      console.log(`  the amendment was: ${amendment.summary}`);
      console.log(`  ($${(costUsd + replayCost).toFixed(3)})`);
      return 1;
    }

    await record(resolved, {
      at: nowIso(),
      skill: amendment.skill,
      action: "applied",
      summary: amendment.summary,
      version: nextVersion,
      evidence: amendment.evidence,
    });
    console.log(`applied to ${amendment.skill} (v${nextVersion}): ${amendment.summary}`);
    console.log(`  ${projectSkillPath(resolved, amendment.skill)}`);
    console.log(`  the frozen set still holds. Cached judge verdicts fall out at the new version.`);
    console.log(`  ($${(costUsd + replayCost).toFixed(3)})`);
    return 0;
  }

  throw new LookoutError(
    `unknown skills subcommand "${sub}"`,
    "expected list | diff | freeze | replay | improve",
  );
}
