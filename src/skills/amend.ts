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
import { dirname } from "node:path";
import { lookoutDir } from "../config.js";
import { loadBacklog } from "../verbs/backlog.js";
import { extractJson, invokeClaude } from "../judge/engine.js";
import { licensedSkills, PANELS } from "../judge/panels.js";
import {
  loadSkill,
  projectSkillPath,
  renderSkill,
  restoreLayer,
  writeLayer,
  type Skill,
} from "./load.js";
import { propose } from "./propose.js";
import { bySkill, gatherSignals, type Signal } from "./signals.js";
import { loadWatermark, newSignals, stampSeen } from "./watermark.js";
import { recordIncident } from "./incidents.js";
import { freezeRegressionSet, loadRegressionSet, usableCases } from "./regression.js";
import { runGate, type GateOutcome } from "./gate.js";
import { GATED_SKILLS } from "./replay.js";
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

/**
 * Read this project's signals, amend a skill, and keep the amendment only if
 * the frozen set still holds.
 *
 * Its own function because it is the one subcommand that writes, and the one
 * that has to be held under a lock while it does.
 */
export interface ImproveOptions {
  /**
   * An automatic trigger is calling: skip free (no model call) whenever the
   * outcome could only be a proposal, because a proposal is a file waiting
   * for a person and the person-facing nudges cover that case for nothing.
   */
  auto?: boolean;
  /** A person explicitly agreeing to spend on a proposal-only outcome. */
  propose?: boolean;
  /** Ignore the watermark and replay every signal ever gathered. */
  allSignals?: boolean;
}

/**
 * What the gate saw on the way to its verdict.
 *
 * Printed whether the candidate passed or failed, because all three of these
 * are about the frozen set rather than the amendment: a panel that keeps
 * relabelling, a claim the unchanged skills no longer reproduce, and how much
 * run-to-run spread the judge showed. Suppressing them would put the gate back
 * to reporting a single sample as a verdict.
 */
function report(outcome: GateOutcome): void {
  for (const d of outcome.drift) {
    console.log(
      `  [drift] ${d.shotId} ${d.panel}: settled as ${d.category}, filed as ${d.filed.join(", ")}`,
    );
  }
  for (const v of outcome.stale) {
    console.log(`  [stale] ${v.shotId} ${v.category}: the unchanged skills lose it too`);
  }
  if (outcome.unreproduced.length > 0) {
    console.log(
      `  ${outcome.unreproduced.length} violation(s) did not reproduce and were not counted`,
    );
  }
}

async function improve(resolved: ResolvedConfig, model: string, opts: ImproveOptions): Promise<number> {
  const signals = await gatherSignals(resolved);
  if (signals.length === 0) {
    console.log("nothing to learn from yet: no refutations, adjudications or blocked issues on record.");
    return 0;
  }

  // Only what no improve pass has been shown before. Old signals were either
  // amended-from (the lesson is in the layer) or attempted (identical
  // evidence would re-produce the identical outcome, at model cost); feeding
  // them back invites re-amending the same lesson forever.
  const mark = await loadWatermark(resolved);
  const shown = opts.allSignals ? signals : newSignals(mark, signals);
  if (shown.length === 0) {
    console.log(
      `nothing new to learn from since ${mark.lastImproveAt ?? "the beginning"}; ` +
        "--all-signals replays everything",
    );
    return 0;
  }
  const grouped = bySkill(shown);
  console.log(
    `${shown.length} new signal(s) across ${grouped.size} skill(s): ` +
      [...grouped].map(([name, list]) => `${name} ${list.length}`).join(", "),
  );

  // The gate first: an amendment written with nothing able to grade it is not
  // applied, so there is no point asking for one until this is known.
  let set = await loadRegressionSet(resolved);
  if (!set) {
    const backlog = await loadBacklog(resolved);
    set = (await freezeRegressionSet(resolved, backlog, nowIso())).set;
  }
  const frozen = set;
  const gradeable = usableCases(resolved, frozen).length;

  // The pair rule, spanning the judging family: any judging signal licenses
  // the core and the refuter alongside the skill it named, and a signal may
  // carry extra licenses of its own (a refuter lesson naming the panel whose
  // finding it overruled). Sibling panels never license each other.
  const attributed = licensedSkills(
    new Set(shown.flatMap((sig) => [sig.skill, ...(sig.licenses ?? [])])),
  );
  const gatedEvidence = [...attributed].some((name) => GATED_SKILLS.has(name));

  // Gated-or-nothing, checked BEFORE the model call it would waste.
  if (gradeable === 0 || (opts.auto && !gatedEvidence)) {
    const why =
      gradeable === 0
        ? "nothing frozen can grade an amendment (settle verdicts, then `lookout skills freeze`)"
        : "the new signals name only skills the frozen set cannot exercise";
    if (opts.auto) {
      console.log(`improve skipped: ${why}.`);
      return 0;
    }
    if (gradeable === 0 && !opts.propose) {
      console.log(`improve not run: ${why}.`);
      console.log("  --propose spends a model call whose best outcome is an unapplied PROPOSED.md");
      return 0;
    }
  }

  const { amendment, costUsd } = await askForAmendment(resolved, shown, model);

  // The amendment has to be about a skill the evidence indicted. The model
  // was handed every skill's description for context, and without this it
  // could amend fact-check off signals about the judge.
  if (!amendment.newSkill && amendment.skill && !attributed.has(amendment.skill)) {
    throw new LookoutError(
      `the amendment names ${amendment.skill}, but the signals shown were about ` +
        `${[...attributed].join(", ")}`,
      "an amendment must answer the evidence that prompted it",
    );
  }

  if (amendment.newSkill) {
    const { name, description, body } = amendment.newSkill;
    const proposalPath = await propose(
      resolved,
      name,
      `# ${name}\n\n${description}\n\n${body.trimEnd()}\n`,
      amendment,
    );
    await stampSeen(resolved, mark, shown, "proposed");
    console.log(`new skill proposed: ${proposalPath}`);
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
    await stampSeen(resolved, mark, shown, "no-change");
    console.log(`no amendment warranted: ${amendment.summary}`);
    return 0;
  }

  const current = await loadSkill(resolved, amendment.skill);
  const existingBody = current.amendmentPath
    ? (await readFile(current.amendmentPath, "utf8")).replace(/^---[\s\S]*?\n---\n/, "")
    : "";
  const nextVersion = current.version + 1;
  const merged = `${existingBody.trimEnd()}\n\n## ${nowIso().slice(0, 10)}: ${amendment.summary}\n\n${amendment.amendment}\n`;

  // A gated panel is still ungradeable when the frozen set holds no claims in
  // its lane: its replay would make zero calls and pass vacuously, which is
  // the exact auto-apply the gate exists to prevent.
  const claimCats = new Set(
    usableCases(resolved, frozen).flatMap((c) =>
      [...c.mustFile, ...c.mustNotFile].map((cl) => cl.category),
    ),
  );
  const panelDef = PANELS.find((p) => p.name === amendment.skill);
  const panelGradeable = !panelDef || panelDef.categories.some((c) => claimCats.has(c));

  if (!GATED_SKILLS.has(amendment.skill) || gradeable === 0 || !panelGradeable) {
    const why =
      gradeable === 0
        ? "there is nothing frozen to grade this against (run `lookout skills freeze`)"
        : !panelGradeable
          ? `the frozen set holds no claims in ${amendment.skill}'s categories`
          : `the frozen set cannot exercise ${amendment.skill}`;
    const p = await propose(resolved, amendment.skill, merged, amendment);
    await stampSeen(resolved, mark, shown, "proposed");
    console.log(`proposed, not applied: ${why}.`);
    console.log(`  ${p}`);
    return 0;
  }

  const layerDescription = `${resolved.project}'s own rules for ${amendment.skill}`;
  const before = await writeLayer(resolved, amendment.skill, merged, nextVersion, layerDescription);

  console.log(`replaying ${gradeable} frozen screenshot(s) against the candidate...`);
  let outcome: GateOutcome;
  try {
    // The gate reproduces a violation and then controls for it, so the layer
    // has to come off and go back on mid-verdict. Safe because improve holds a
    // lock: nothing else is reading this skill's layer while it happens.
    outcome = await runGate(resolved, frozen, model, {
      amendedSkill: amendment.skill,
      withoutCandidate: async (fn) => {
        await restoreLayer(resolved, amendment.skill, before);
        try {
          return await fn();
        } finally {
          await writeLayer(resolved, amendment.skill, merged, nextVersion, layerDescription);
        }
      },
    });
  } catch (e) {
    await restoreLayer(resolved, amendment.skill, before);
    // An infrastructure failure, not evidence against the amendment: the
    // watermark is NOT stamped, so the same evidence gets another chance.
    recordIncident({
      at: nowIso(),
      kind: "skill-rollback",
      verb: "skills improve",
      message: `amendment to ${amendment.skill} rolled back: the replay could not run`,
      detail: (e as Error).message.slice(0, 400),
      project: resolved.projectDir,
    });
    throw new LookoutError(
      `the replay could not run, so the amendment was rolled back: ${(e as Error).message}`,
    );
  }

  const { violations, drift, stale } = outcome;
  const replayCost = outcome.costUsd;
  report(outcome);

  if (violations.length > 0) {
    await restoreLayer(resolved, amendment.skill, before);
    await record(resolved, {
      at: nowIso(),
      skill: amendment.skill,
      action: "rolled-back",
      summary: amendment.summary,
      evidence: amendment.evidence,
      violations,
      drift,
      stale,
    });
    // Stamped seen: identical evidence would produce the identical rollback
    // at model cost each time. And bridged to the machine-wide incident log:
    // one rollback is the gate working, but only that log can see "the same
    // skill keeps rolling back across runs and projects", which indicts the
    // machinery rather than the project.
    await stampSeen(resolved, mark, shown, "rolled-back");
    recordIncident({
      at: nowIso(),
      kind: "skill-rollback",
      verb: "skills improve",
      message: `amendment to ${amendment.skill} rolled back: ${violations.length} violation(s)`,
      detail: `${amendment.summary} | ${violations.map((v) => v.kind).join(", ")}`,
      project: resolved.projectDir,
    });
    console.log(
    `rolled back: the candidate broke ${violations.length} settled verdict(s), ` +
      `confirmed over ${outcome.rounds} replay(s).`,
  );
    for (const v of violations) {
    console.log(`  [${v.kind}] ${v.shotId} ${v.panel} ${v.category}: ${v.why}`);
  }
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
  await stampSeen(resolved, mark, shown, "applied");
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
export async function improveSkills(
  resolved: ResolvedConfig,
  model: string,
  opts: ImproveOptions = {},
): Promise<number> {
  const lock = improveLockPath(resolved);
  if (lockHeld(lock)) {
    throw new LookoutError("another skills improve is already running", `if it died, remove ${lock}`);
  }
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, nowIso());
  try {
    return await improve(resolved, model, opts);
  } finally {
    await rm(lock, { force: true });
  }
}
