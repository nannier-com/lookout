/**
 * The capture matrix: which form factors, schemes and platforms one run walks.
 *
 * Pure, so the defaults are testable without a browser, and in one place, so
 * a verb cannot quietly default to fewer form factors than a sweep does. The
 * walk order is the order of the constants, whatever order a flag listed, and
 * a value outside the set is answered with the set rather than ignored.
 */
import {
  FORM_FACTORS,
  LookoutError,
  PLATFORMS,
  SCHEMES,
  type FormFactor,
  type PlatformKind,
  type Scheme,
} from "../types.js";
import { list } from "../util.js";
import type { ProjectKind } from "../project-kind.js";

function pick<T extends string>(
  flag: string | boolean | undefined,
  all: readonly T[],
  what: string,
): T[] | undefined {
  const asked = list(flag);
  if (!asked) return undefined;
  for (const value of asked) {
    if (!(all as readonly string[]).includes(value)) {
      throw new LookoutError(`unknown ${what} "${value}" (${all.join(" | ")})`);
    }
  }
  return all.filter((value) => asked.includes(value));
}

/** The form factors a run walks: every one by default, `--viewports` narrows. */
export function resolveFormFactors(flag: string | boolean | undefined): FormFactor[] {
  return pick(flag, FORM_FACTORS, "viewport") ?? [...FORM_FACTORS];
}

/**
 * The schemes a run walks: the flag decides, else the schemes the project says
 * it ships, else both.
 *
 * Both is the fallback rather than the truth. A project that never declared
 * cannot be assumed to have one scheme, so lookout photographs the pair and
 * lets the byte-identical check speak; a project that declared one is taken at
 * its word and photographed once, which is also half the shots.
 */
export function resolveSchemes(
  flag: string | boolean | undefined,
  declared?: readonly Scheme[],
): Scheme[] {
  const asked = pick(flag, SCHEMES, "scheme");
  if (asked) return asked;
  if (declared && declared.length > 0) return SCHEMES.filter((s) => declared.includes(s));
  return [...SCHEMES];
}

/**
 * The platforms a run walks: the project's fold by default, `--platforms`
 * decides outright for one run.
 */
export function resolvePlatforms(flag: string | boolean | undefined, kind: ProjectKind): PlatformKind[] {
  return pick(flag, PLATFORMS, "platform") ?? defaultPlatforms(kind);
}

/** What a run photographs when nobody said: the web fold, the device fold, or both. */
export function defaultPlatforms(kind: ProjectKind): PlatformKind[] {
  const out: PlatformKind[] = [];
  if (kind.web) out.push("web");
  out.push(...kind.native);
  return out;
}
