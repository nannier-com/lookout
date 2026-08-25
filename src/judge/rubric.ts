/**
 * Rubric assembly: the base rubric shipped with lookout, plus the project's
 * extension file and never-file lines from config. rubricVersion (parsed from
 * the base header, bumped by the project extension's own header when higher)
 * keys the judge cache: bump it to force fresh eyes on everything.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
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
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function parseVersion(text: string, source: string): number {
  const m = text.match(/rubricVersion:\s*(\d+)/);
  if (!m) throw new LookoutError(`${source} has no "rubricVersion: N" header`);
  return Number(m[1]);
}

export async function loadRubric(resolved: ResolvedConfig): Promise<Rubric> {
  const basePath = fileURLToPath(new URL("../../rubric/BASE.md", import.meta.url));
  const base = await readFile(basePath, "utf8");
  let version = parseVersion(base, "rubric/BASE.md");
  let text = base;

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
    const extVersion = ext.match(/rubricVersion:\s*(\d+)/)
      ? parseVersion(ext, extPath)
      : 0;
    version = Math.max(version, extVersion);
    text += `\n\n# Project extension (${resolved.project})\n\n${ext}\n`;
  }

  if (config.neverFile && config.neverFile.length > 0) {
    text +=
      `\n\n## Additional never-file rules for ${resolved.project}\n\n` +
      config.neverFile.map((l) => `- ${l}`).join("\n") +
      "\n";
  }

  return { text, version };
}
