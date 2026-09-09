/**
 * Config validation: the raw object a project's config file exported, held to
 * the LookoutConfig shape with precise messages.
 *
 * Hand-rolled rather than a schema library: the config is small enough that a
 * library would cost more than it saves. Split from config.ts because loading
 * (finding the file, importing it, zero-config synthesis) and validating are
 * edited for different reasons, and the file had hit the line ceiling. Split
 * again into config-validate-parts.ts for the same reason: this file is the
 * composition, one field after another, and the pieces live next door.
 */
import {
  DEFAULT_VIEWPORTS,
  DIRECTION_PRESETS,
  FORM_FACTORS,
  PLATFORMS,
  SCHEMES,
  type DesignSystemDeclaration,
  type DirectionDeclaration,
  type DirectionPreset,
  type FormFactor,
  type LookoutConfig,
  type SchemeConfig,
  type Viewport,
} from "./types.js";
import { enumArray, fail, isRecord, validateTargets } from "./config-validate-parts.js";

export function validateConfig(raw: unknown, path: string): LookoutConfig {
  if (!isRecord(raw)) fail(path, "config must be an object");

  const validTargets = validateTargets(raw, path);

  let scheme: SchemeConfig | undefined;
  if (raw.scheme !== undefined) {
    if (!isRecord(raw.scheme) || typeof raw.scheme.mode !== "string") {
      fail(path, "scheme must be { mode: \"emulate\" | \"url-param\" | \"recipe\" }");
    }
    const mode = raw.scheme.mode;
    if (mode === "emulate") scheme = { mode };
    else if (mode === "url-param") {
      if (typeof raw.scheme.param !== "string") fail(path, "scheme.param must be a string");
      scheme = { mode, param: raw.scheme.param };
    } else if (mode === "recipe") scheme = { mode };
    else fail(path, `unknown scheme.mode "${mode}"`);
  }

  let viewports: Partial<Record<FormFactor, Viewport>> | undefined;
  if (raw.viewports !== undefined) {
    if (!isRecord(raw.viewports)) fail(path, "viewports must be an object");
    viewports = {};
    for (const key of Object.keys(raw.viewports)) {
      if (!(key in DEFAULT_VIEWPORTS)) {
        fail(path, `viewports.${key}: unknown form factor (${FORM_FACTORS.join(" | ")})`);
      }
      const v = (raw.viewports as Record<string, unknown>)[key];
      if (!isRecord(v) || typeof v.width !== "number" || typeof v.height !== "number") {
        fail(path, `viewports.${key} must be { width, height }`);
      }
      viewports[key as FormFactor] = { width: v.width, height: v.height };
    }
  }

  // The fold, when the project says it. Validated against the platform set,
  // and a device platform named here still needs its native block to run.
  const platforms = enumArray(raw.platforms, PLATFORMS, "platforms", path);

  // Which schemes exist, not how to switch between them: `scheme` is the
  // mechanism and this is the vocabulary it switches within.
  const schemes = enumArray(raw.schemes, SCHEMES, "schemes", path);

  if (raw.states !== undefined) {
    if (!isRecord(raw.states)) fail(path, "states must be an object of recipes");
    for (const [name, recipe] of Object.entries(raw.states)) {
      if (!isRecord(recipe) || typeof recipe.prepare !== "function") {
        fail(path, `states.${name} must be { prepare(page) } (a function)`);
      }
    }
  }

  if (raw.native !== undefined) {
    if (!isRecord(raw.native)) fail(path, "native must be an object");
    if (raw.native.target !== undefined && typeof raw.native.target !== "string") {
      fail(path, "native.target must be a target name string");
    }
    for (const os of ["ios", "android"] as const) {
      const n = (raw.native as Record<string, unknown>)[os];
      if (n === undefined) continue;
      if (!isRecord(n) || typeof n.deepLinkScheme !== "string" || typeof n.bundleId !== "string") {
        fail(path, `native.${os} must declare deepLinkScheme and bundleId`);
      }
      if (n.startHint !== undefined && typeof n.startHint !== "string") {
        fail(path, `native.${os}.startHint must be a string`);
      }
      if (n.devices !== undefined) {
        const ok = Array.isArray(n.devices) && n.devices.length > 0 && n.devices.every((d) => d === "phone" || d === "tablet");
        if (!ok) fail(path, `native.${os}.devices must be a non-empty array of "phone" | "tablet"`);
      }
    }
  }

  if (raw.shellScoping !== undefined && typeof raw.shellScoping !== "boolean") {
    fail(path, "shellScoping must be a boolean");
  }

  let navigation: LookoutConfig["navigation"];
  if (raw.navigation !== undefined) {
    if (!isRecord(raw.navigation)) fail(path, "navigation must be an object");
    const n = raw.navigation;
    if (n.enabled !== undefined && typeof n.enabled !== "boolean") {
      fail(path, "navigation.enabled must be a boolean");
    }
    for (const key of [
      "maxStatesPerRoute",
      "maxChecksPerRoute",
      "maxFocusStatesPerRoute",
      "maxHoverStatesPerRoute",
    ] as const) {
      if (n[key] !== undefined && (typeof n[key] !== "number" || n[key] < 0)) {
        fail(path, `navigation.${key} must be a non-negative number`);
      }
    }
    for (const key of ["exclude", "include"] as const) {
      const v = n[key];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
        fail(path, `navigation.${key} must be an array of strings`);
      }
    }
    navigation = n as LookoutConfig["navigation"];
  }

  let map: LookoutConfig["map"];
  if (raw.map !== undefined) {
    if (!isRecord(raw.map)) fail(path, "map must be an object");
    const m = raw.map;
    if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
      fail(path, "map.enabled must be a boolean");
    }
    for (const key of ["maxScreens", "maxDepth", "maxChildren", "fileBudget"] as const) {
      if (m[key] !== undefined && (typeof m[key] !== "number" || m[key] < 0)) {
        fail(path, `map.${key} must be a non-negative number`);
      }
    }
    for (const key of ["exclude", "include"] as const) {
      const v = m[key];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
        fail(path, `map.${key} must be an array of strings`);
      }
    }
    map = m as LookoutConfig["map"];
  }

  let checks: LookoutConfig["checks"];
  if (raw.checks !== undefined) {
    if (!isRecord(raw.checks)) fail(path, "checks must be an object");
    const c = raw.checks;
    if (c.edgeClip !== undefined) {
      if (!isRecord(c.edgeClip)) fail(path, "checks.edgeClip must be an object");
      const v = (c.edgeClip as Record<string, unknown>).ignore;
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
        fail(path, "checks.edgeClip.ignore must be an array of strings");
      }
    }
    checks = c as LookoutConfig["checks"];
  }

  let learn: LookoutConfig["learn"];
  if (raw.learn !== undefined) {
    if (!isRecord(raw.learn)) fail(path, "learn must be an object");
    const l = raw.learn;
    if (l.auto !== undefined && typeof l.auto !== "boolean") fail(path, "learn.auto must be a boolean");
    for (const key of ["threshold", "cooldownHours"] as const) {
      if (l[key] !== undefined && (typeof l[key] !== "number" || l[key] < 0)) {
        fail(path, `learn.${key} must be a non-negative number`);
      }
    }
    learn = l as LookoutConfig["learn"];
  }

  let designSystem: DesignSystemDeclaration | undefined;
  if (raw.designSystem !== undefined) {
    if (!isRecord(raw.designSystem)) fail(path, "designSystem must be an object");
    const d = raw.designSystem;
    const strArray = (key: string): string[] | undefined => {
      const v = d[key];
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        fail(path, `designSystem.${key} must be an array of strings`);
      }
      return v as string[];
    };
    const strField = (key: string): string | undefined => {
      const v = d[key];
      if (v === undefined) return undefined;
      if (typeof v !== "string") fail(path, `designSystem.${key} must be a string`);
      return v;
    };
    if (d.editable !== undefined && typeof d.editable !== "boolean") {
      fail(path, "designSystem.editable must be a boolean");
    }
    designSystem = {
      name: strField("name"),
      packageRoot: strField("packageRoot"),
      componentRoots: strArray("componentRoots"),
      importPrefixes: strArray("importPrefixes"),
      tokenFiles: strArray("tokenFiles"),
      docs: strField("docs"),
      editable: d.editable as boolean | undefined,
    };
  }

  let direction: DirectionDeclaration | undefined;
  if (raw.direction !== undefined) {
    const d = typeof raw.direction === "string" ? { preset: raw.direction } : raw.direction;
    if (!isRecord(d)) fail(path, "direction must be a preset name or { preset?, file? }");
    if (d.preset !== undefined && !(DIRECTION_PRESETS as readonly unknown[]).includes(d.preset)) {
      fail(path, `direction.preset must be one of ${DIRECTION_PRESETS.join(" | ")}, not ${JSON.stringify(d.preset)}`);
    }
    if (d.file !== undefined && typeof d.file !== "string") fail(path, "direction.file must be a path string");
    if (d.preset === undefined && d.file === undefined) fail(path, "direction needs a preset, a file, or both");
    direction = {
      ...(d.preset !== undefined ? { preset: d.preset as DirectionPreset } : {}),
      ...(d.file !== undefined ? { file: d.file as string } : {}),
    };
  }

  if (raw.aria !== undefined && typeof raw.aria !== "boolean") {
    fail(path, "aria must be a boolean");
  }
  if (raw.provenance !== undefined && typeof raw.provenance !== "boolean") {
    fail(path, "provenance must be a boolean");
  }

  return {
    project: typeof raw.project === "string" ? raw.project : undefined,
    targets: validTargets,
    viewports,
    platforms,
    scheme,
    schemes,
    states: raw.states as LookoutConfig["states"],
    element: typeof raw.element === "string" ? raw.element : undefined,
    shellScoping: raw.shellScoping as boolean | undefined,
    rubric: typeof raw.rubric === "string" ? raw.rubric : undefined,
    neverFile: Array.isArray(raw.neverFile)
      ? raw.neverFile.filter((s): s is string => typeof s === "string")
      : undefined,
    designSystem,
    direction,
    native: raw.native as LookoutConfig["native"],
    learn,
    navigation,
    map,
    checks,
    provenance: raw.provenance as boolean | undefined,
  };
}
