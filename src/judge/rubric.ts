/**
 * Rubric assembly: the judge-core skill (which carries the base rubric and
 * whatever the project's own layer has amended into it), plus the hand-written
 * extension file and never-file lines from config. The composed version keys
 * the judge cache: bump it to force fresh eyes on everything.
 *
 * The base rubric moved into `skills/judge-core/rubric.md` when every AI
 * capability became a skill. This module stays because the judge has config
 * nothing else has (`config.rubric`, `config.neverFile`), and that belongs next
 * to the judge rather than in the generic loader.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fillPlaceholders, loadSkill, shippedSkillDir } from "../skills/load.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { CORE_JUDGE, PANELS, type PanelDef } from "./panels.js";
import { directionBlock, loadDirection, type LoadedDirection } from "./direction.js";

/** One panel's composed judge: its registry entry, and the prompt it judges by. */
export interface PanelRubric {
  def: PanelDef;
  /** Core rubric with this panel's vocabulary and the project extensions. */
  text: string;
  /** max(core, panel, extension): the human-readable ledger field. */
  version: number;
  /** Hand-off prose for the conditional {{handoff}} fill; "" except design-parity. */
  handoff: string;
}

export interface Rubric {
  text: string;
  version: number;
  /**
   * The design hand-off instructions, held back rather than baked in.
   *
   * They are a quarter of the rubric and they apply only to a shot carrying a
   * `design:` reference, so every project without hand-offs was paying that much
   * of every judge prompt for the most nuanced passage in the document. The
   * prompt builder fills the `{{handoff}}` slot with this only when the batch
   * actually has one.
   */
  handoff: string;
}

export const CATEGORIES = [
  "render-failure",
  "layout-overflow",
  "alignment",
  "spacing",
  "hierarchy",
  "typography",
  "color-scheme",
  "contrast",
  "states",
  "responsive",
  "anatomy",
  "consistency",
  // The holistic band: the view as a whole reading as unfinished, rather than
  // any one element being wrong. Added rather than replacing anything, because
  // a category name is part of every fingerprint and cluster key in every
  // project's backlog, and renaming one would orphan the findings under it.
  "composition",
  "a11y",
  "content",
  "design-parity",
  // The choices nobody made: the defaults a generic build falls into where the
  // project declared nothing else. Its own token, never a rename, for the same
  // reason as composition: a category is identity in every backlog.
  "taste",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function parseVersion(text: string, source: string): number {
  const m = text.match(/rubricVersion:\s*(\d+)/);
  if (!m) throw new LookoutError(`${source} has no "rubricVersion: N" header`);
  return Number(m[1]);
}

/** Everything a composition needs, loaded once: core, panels, extensions, hand-off. */
async function loadParts(resolved: ResolvedConfig): Promise<{
  core: Awaited<ReturnType<typeof loadSkill>>;
  panelSkills: Awaited<ReturnType<typeof loadSkill>>[];
  extensions: string;
  extVersion: number;
  handoff: string;
  direction: LoadedDirection | null;
}> {
  const core = await loadSkill(resolved, CORE_JUDGE);
  const panelSkills = await Promise.all(PANELS.map((p) => loadSkill(resolved, p.name)));

  let extensions = "";
  let extVersion = 0;
  // Hand-written project rules come after anything lookout learned on its own:
  // where the two disagree, the rule a person wrote is the one that stands.
  const { config, configPath } = resolved;
  if (config.rubric) {
    if (!configPath) {
      throw new LookoutError("config.rubric needs a config file to resolve against");
    }
    const extPath = isAbsolute(config.rubric)
      ? config.rubric
      : join(dirname(configPath), config.rubric);
    if (!existsSync(extPath)) {
      throw new LookoutError(`project rubric not found: ${extPath}`);
    }
    const ext = await readFile(extPath, "utf8");
    extVersion = ext.match(/rubricVersion:\s*(\d+)/) ? parseVersion(ext, extPath) : 0;
    extensions += `\n\n# Project extension (${resolved.project})\n\n${ext}\n`;
  }

  if (config.neverFile && config.neverFile.length > 0) {
    extensions +=
      `\n\n## Additional never-file rules for ${resolved.project}\n\n` +
      config.neverFile.map((l) => `- ${l}`).join("\n") +
      "\n";
  }

  const handoffPath = join(shippedSkillDir("judge-design-parity"), "handoff.md");
  const handoff = existsSync(handoffPath) ? await readFile(handoffPath, "utf8") : "";
  // The declared direction is read here, once per composition, and never by
  // the judge: the prompt carries its text and a config-relative name only.
  const direction = await loadDirection(resolved);
  return { core, panelSkills, extensions, extVersion, handoff, direction };
}

/**
 * The whole rubric as one text: every panel's vocabulary in registry order.
 * The pipeline judges per panel now; this union remains for callers that want
 * the complete document (tests, and any prompt that reasons about the whole).
 */
export async function loadRubric(resolved: ResolvedConfig): Promise<Rubric> {
  const { core, panelSkills, extensions, extVersion, handoff, direction } = await loadParts(resolved);
  const panelText = panelSkills.map((p) => p.text.trim()).join("\n");
  const version = Math.max(core.version, extVersion, ...panelSkills.map((p) => p.version));
  // The skill says where project rules belong; filling it here keeps them in
  // the rubric rather than trailing the shot manifest. `{{handoff}}` is left
  // for the prompt builder, which is the only thing that knows whether this
  // batch has a design reference to compare against.
  return {
    text: fillPlaceholders(core.text, { panel: panelText, extensions, direction: directionBlock(direction) }),
    version,
    handoff,
  };
}

/**
 * One composed judge per panel: the shared core with only that panel's
 * vocabulary in the {{panel}} slot. Project extensions and neverFile lines
 * reach every panel (a hand-written rule may touch any lane; one a panel
 * cannot act on is harmless prose). The hand-off text rides only with
 * design-parity, so editing handoff.md invalidates only its entries, and the
 * declared direction is filled only into the panels flagged for it (taste),
 * so editing a DESIGN.md invalidates only theirs.
 */
export async function loadJudges(resolved: ResolvedConfig): Promise<PanelRubric[]> {
  const { core, panelSkills, extensions, extVersion, handoff, direction } = await loadParts(resolved);
  return PANELS.map((def, i) => {
    const skill = panelSkills[i]!;
    return {
      def,
      text: fillPlaceholders(core.text, {
        panel: skill.text.trim(),
        extensions,
        direction: def.direction ? directionBlock(direction) : "",
      }),
      version: Math.max(core.version, skill.version, extVersion),
      handoff: def.designOnly ? handoff : "",
    };
  });
}
