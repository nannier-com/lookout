/**
 * Rubric assembly: the visual-judge skill (which carries the base rubric and
 * whatever the project's own layer has amended into it), plus the hand-written
 * extension file and never-file lines from config. The composed version keys
 * the judge cache: bump it to force fresh eyes on everything.
 *
 * The base rubric moved into `skills/visual-judge/rubric.md` when every AI
 * capability became a skill. This module stays because the judge has config
 * nothing else has (`config.rubric`, `config.neverFile`), and that belongs next
 * to the judge rather than in the generic loader.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fillPlaceholders, loadSkill } from "../skills/load.js";
import { LookoutError, type ResolvedConfig } from "../types.js";

export interface Rubric {
  text: string;
  version: number;
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
  "a11y",
  "content",
  "design-parity",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function parseVersion(text: string, source: string): number {
  const m = text.match(/rubricVersion:\s*(\d+)/);
  if (!m) throw new LookoutError(`${source} has no "rubricVersion: N" header`);
  return Number(m[1]);
}

export async function loadRubric(resolved: ResolvedConfig): Promise<Rubric> {
  const skill = await loadSkill(resolved, "visual-judge");
  let version = skill.version;
  let extensions = "";

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
    const extVersion = ext.match(/rubricVersion:\s*(\d+)/) ? parseVersion(ext, extPath) : 0;
    version = Math.max(version, extVersion);
    extensions += `\n\n# Project extension (${resolved.project})\n\n${ext}\n`;
  }

  if (config.neverFile && config.neverFile.length > 0) {
    extensions +=
      `\n\n## Additional never-file rules for ${resolved.project}\n\n` +
      config.neverFile.map((l) => `- ${l}`).join("\n") +
      "\n";
  }

  // The skill says where project rules belong; filling it here keeps them in
  // the rubric rather than trailing the shot manifest.
  return { text: fillPlaceholders(skill.text, { extensions }), version };
}
