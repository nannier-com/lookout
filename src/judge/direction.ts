/**
 * The design direction a project declared, and what the project declared as
 * the refuter is shown it.
 *
 * The taste panel judges undeclared choices against the defaults a generic
 * build falls into. Beyond those, design practices contradict each other (no
 * radius against soft corners, gradients banned against gradients encouraged),
 * and none of that is judgeable until the project says which direction it
 * chose. `direction` in the config is where it says so: a shipped preset, its
 * own file (a DESIGN.md, or one written in the preset shape), or both.
 *
 * lookout reads the file here, when the prompt is composed; the judge never
 * opens it. Its cwd is a scratch directory and the only path it is handed is
 * the config-relative spelling, so a project's tree stays out of the oracle's
 * reach. The text is filled into the taste panel's composed prompt and no
 * other, so it enters that panel's ledger key alone: editing a DESIGN.md
 * re-judges taste and leaves every other verdict standing.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { shippedSkillDir } from "../skills/load.js";
import { DIRECTION_PRESETS, LookoutError, type DirectionPreset, type ResolvedConfig } from "../types.js";

/** How much of a project's own direction file reaches the judge. */
export const DIRECTION_MAX_CHARS = 12_000;

export interface LoadedDirection {
  /** The config-relative spelling of where it came from, never an absolute path. */
  source: string;
  text: string;
  /** Lines of the project's own file that did not reach the judge. */
  cut: number;
}

/** Where a shipped preset lives: inside the taste skill, so it ships with the package. */
export function presetPath(preset: DirectionPreset): string {
  return join(shippedSkillDir("judge-taste"), "directions", `${preset}.md`);
}

/**
 * Trim a project's direction file to what a judge can use.
 *
 * A Stitch-format DESIGN.md is mostly token tables, and its `components:`
 * mapping (per-component token references) is the bulk of it while saying
 * nothing a still can show, so over budget that mapping goes first, whole.
 * What is still over the cap is cut on a line boundary with a marker saying
 * how much did not arrive, so a judge reading a truncated file knows it is
 * one. Deterministic and free: a model summary would cost a call per run and
 * would need its own cache.
 */
export function capDirection(text: string, max = DIRECTION_MAX_CHARS): { text: string; cut: number } {
  if (text.length <= max) return { text, cut: 0 };
  let out = text;
  let cut = 0;
  const fm = out.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const lines = fm[1]!.split("\n");
    const start = lines.findIndex((l) => /^components:\s*$/.test(l));
    if (start !== -1) {
      let end = start + 1;
      while (end < lines.length && /^(\s|$)/.test(lines[end]!)) end++;
      cut += end - start;
      const kept = [...lines.slice(0, start), ...lines.slice(end)];
      out = `---\n${kept.join("\n")}\n---\n${out.slice(fm[0].length)}`;
    }
  }
  if (out.length > max) {
    const head = out.slice(0, max);
    const at = head.lastIndexOf("\n");
    const keptText = at > 0 ? head.slice(0, at) : head;
    const dropped = out.slice(keptText.length).split("\n").length - 1;
    cut += dropped;
    out =
      `${keptText}\n\n(cut for length: ${dropped} more line(s) of this file did not reach the judge; ` +
      "keep the rules above the token tables)\n";
  }
  return { text: out, cut };
}

/** The declared direction, composed from the preset and the project's file, or null when none is declared. */
export async function loadDirection(resolved: ResolvedConfig): Promise<LoadedDirection | null> {
  const raw = resolved.config.direction;
  if (raw === undefined) return null;
  const decl = typeof raw === "string" ? { preset: raw } : raw;
  const parts: string[] = [];
  const sources: string[] = [];
  let cut = 0;
  if (decl.preset !== undefined) {
    if (!(DIRECTION_PRESETS as readonly string[]).includes(decl.preset)) {
      throw new LookoutError(
        `unknown design direction preset "${decl.preset}"`,
        `one of ${DIRECTION_PRESETS.join(" | ")}`,
      );
    }
    const path = presetPath(decl.preset);
    if (!existsSync(path)) {
      throw new LookoutError(
        `design direction preset "${decl.preset}" is missing from this lookout install`,
        `expected ${path}`,
      );
    }
    parts.push((await readFile(path, "utf8")).trim());
    sources.push(`preset "${decl.preset}"`);
  }
  if (decl.file !== undefined) {
    if (!resolved.configPath) {
      throw new LookoutError("direction.file needs a config file to resolve against");
    }
    const path = isAbsolute(decl.file) ? decl.file : join(dirname(resolved.configPath), decl.file);
    if (!existsSync(path)) throw new LookoutError(`project design direction not found: ${path}`);
    const capped = capDirection(await readFile(path, "utf8"));
    parts.push(capped.text.trim());
    cut += capped.cut;
    sources.push(isAbsolute(decl.file) ? basename(decl.file) : decl.file);
  }
  if (parts.length === 0) return null;
  return { source: sources.join(" + "), text: parts.join("\n\n"), cut };
}

/** The `{{direction}}` fill for a panel given the direction; "" for every other panel and when none is declared. */
export function directionBlock(d: LoadedDirection | null): string {
  if (!d) return "";
  return `\n\n## Declared design direction (${d.source})\n\n${d.text}\n`;
}

/** The refuter's "What the project declared" section, or "" when nothing is. */
export function declaredBlock(
  neverFile: readonly string[] | undefined,
  direction: LoadedDirection | null,
): string {
  const parts: string[] = [];
  if (neverFile && neverFile.length > 0) {
    parts.push("Never-file rules:\n" + neverFile.map((l) => `- ${l}`).join("\n"));
  }
  if (direction) {
    parts.push(`Declared direction (${direction.source}):\n${direction.text.trim()}`);
  }
  return parts.join("\n\n");
}
