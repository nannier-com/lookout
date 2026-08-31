/**
 * Writing an amendment, and keeping it only if the evidence still holds.
 *
 * This is deliberately not a proposal workflow. An amendment that survives the
 * frozen set is applied, because a gate a human has to walk through every time
 * is a gate that stops being walked. What makes that safe is that the gate is
 * evidence rather than judgement: screenshots whose verdicts were settled when
 * the pixels were fresh, including the ones a person ruled intentional and
 * wrote a reason for.
 *
 * An amendment to a skill the frozen set cannot exercise is written down as a
 * proposal instead. Auto-applying a change nothing can grade is the exact thing
 * the gate exists to prevent.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookoutDir } from "../config.js";
import { loadBacklog } from "../verbs/backlog.js";
import { extractJson, invokeClaude } from "../judge/engine.js";
import { loadSkill, projectSkillPath, renderSkill, type Skill } from "./load.js";
import { bySkill, gatherSignals, type Signal } from "./signals.js";
import { freezeRegressionSet, loadRegressionSet, usableCases, type Violation } from "./regression.js";
import { GATED_SKILLS, replayRegression } from "./replay.js";
import { improveLockPath, record, SKILL_NAMES } from "./history.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { lockHeld, nowIso } from "../util.js";

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

/**
 * Read this project's signals, amend a skill, and keep the amendment only if
 * the frozen set still holds.
 *
 * Its own function because it is the one subcommand that writes, and the one
 * that has to be held under a lock while it does.
 */
async function improve(resolved: ResolvedConfig, model: string): Promise<number> {
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

/**
 * One improve at a time.
 *
 * An amendment is written by replacing this project's skill layer and rolled
 * back by restoring whatever was there before, so a second improve running over
 * the top of the first would restore the first's "before" and quietly delete an
 * amendment that had already passed the gate. It is also the lock the page
 * reads to say lookout is learning right now.
 */
export async function improveSkills(resolved: ResolvedConfig, model: string): Promise<number> {
  const lock = improveLockPath(resolved);
  if (lockHeld(lock)) {
    throw new LookoutError("another skills improve is already running", `if it died, remove ${lock}`);
  }
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, nowIso());
  try {
    return await improve(resolved, model);
  } finally {
    await rm(lock, { force: true });
  }
}
