/**
 * Config validation: the raw object a project's config file exported, held to
 * the LookoutConfig shape with precise messages.
 *
 * Hand-rolled rather than a schema library: the config is small enough that a
 * library would cost more than it saves. Split from config.ts because loading
 * (finding the file, importing it, zero-config synthesis) and validating are
 * edited for different reasons, and the file had hit the line ceiling.
 */
import {
  DEFAULT_VIEWPORTS,
  FORM_FACTORS,
  LookoutError,
  PLATFORMS,
  type DesignSystemDeclaration,
  type FormFactor,
  type LookoutConfig,
  type PlatformKind,
  type RouteDef,
  type SchemeConfig,
  type TargetDef,
  type Viewport,
} from "./types.js";

function fail(path: string, msg: string): never {
  throw new LookoutError(`invalid lookout config (${path}): ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateConfig(raw: unknown, path: string): LookoutConfig {
  if (!isRecord(raw)) fail(path, "config must be an object");

  const targets = raw.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    fail(path, "targets must be a non-empty array");
  }
  const seen = new Set<string>();
  const validTargets: TargetDef[] = targets.map((t, i) => {
    if (!isRecord(t)) fail(path, `targets[${i}] must be an object`);
    if (typeof t.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(t.name)) {
      fail(path, `targets[${i}].name must be a short handle (letters, digits, dashes)`);
    }
    if (seen.has(t.name)) fail(path, `duplicate target name "${t.name}"`);
    seen.add(t.name);
    if (typeof t.url !== "string") fail(path, `targets[${i}].url must be a string`);
    try {
      new URL(t.url);
    } catch {
      fail(path, `targets[${i}].url is not a valid URL: ${t.url}`);
    }
    const routes = t.routes as unknown;
    let validRoutes: (string | RouteDef)[] | undefined;
    if (routes !== undefined) {
      if (!Array.isArray(routes)) fail(path, `targets[${i}].routes must be an array`);
      validRoutes = routes.map((r, j) => {
        if (typeof r === "string") return r;
        if (!isRecord(r) || typeof r.path !== "string") {
          fail(path, `targets[${i}].routes[${j}] must be a string or { path }`);
        }
        if (r.design !== undefined && typeof r.design !== "string") {
          fail(path, `targets[${i}].routes[${j}].design must be a path string`);
        }
        for (const key of ["name", "element"] as const) {
          if (r[key] !== undefined && typeof r[key] !== "string") {
            fail(path, `targets[${i}].routes[${j}].${key} must be a string`);
          }
        }
        if (
          r.states !== undefined &&
          (!Array.isArray(r.states) || r.states.some((s) => typeof s !== "string"))
        ) {
          fail(path, `targets[${i}].routes[${j}].states must be an array of recipe names`);
        }
        if (r.navigation !== undefined && typeof r.navigation !== "boolean") {
          fail(path, `targets[${i}].routes[${j}].navigation must be a boolean`);
        }
        if (r.provenance !== undefined && typeof r.provenance !== "boolean") {
          fail(path, `targets[${i}].routes[${j}].provenance must be a boolean`);
        }
        return r as unknown as RouteDef;
      });
    }
    const signIn = t.signIn;
    if (signIn !== undefined && typeof signIn !== "function") {
      fail(path, `targets[${i}].signIn must be a function (page) => Promise<void>`);
    }
    let query: Record<string, string> | undefined;
    if (t.query !== undefined) {
      if (!isRecord(t.query)) fail(path, `targets[${i}].query must be an object of strings`);
      query = {};
      for (const [k, v] of Object.entries(t.query)) {
        if (typeof v !== "string") fail(path, `targets[${i}].query.${k} must be a string`);
        query[k] = v;
      }
    }
    return {
      name: t.name,
      url: t.url.replace(/\/$/, ""),
      routes: validRoutes,
      readyPath: typeof t.readyPath === "string" ? t.readyPath : undefined,
      startHint: typeof t.startHint === "string" ? t.startHint : undefined,
      query,
      signIn: signIn as TargetDef["signIn"],
    };
  });

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
  let platforms: PlatformKind[] | undefined;
  if (raw.platforms !== undefined) {
    if (!Array.isArray(raw.platforms) || raw.platforms.length === 0) {
      fail(path, "platforms must be a non-empty array of web | ios | android");
    }
    for (const p of raw.platforms) {
      if (!(PLATFORMS as readonly unknown[]).includes(p)) {
        fail(path, `platforms: unknown platform ${JSON.stringify(p)} (${PLATFORMS.join(" | ")})`);
      }
    }
    platforms = [...new Set(raw.platforms as PlatformKind[])];
  }

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
    for (const key of ["maxStatesPerRoute", "maxChecksPerRoute"] as const) {
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

  if (raw.provenance !== undefined && typeof raw.provenance !== "boolean") {
    fail(path, "provenance must be a boolean");
  }

  return {
    project: typeof raw.project === "string" ? raw.project : undefined,
    targets: validTargets,
    viewports,
    platforms,
    scheme,
    states: raw.states as LookoutConfig["states"],
    element: typeof raw.element === "string" ? raw.element : undefined,
    shellScoping: raw.shellScoping as boolean | undefined,
    rubric: typeof raw.rubric === "string" ? raw.rubric : undefined,
    neverFile: Array.isArray(raw.neverFile)
      ? raw.neverFile.filter((s): s is string => typeof s === "string")
      : undefined,
    designSystem,
    native: raw.native as LookoutConfig["native"],
    learn,
    navigation,
    checks,
    provenance: raw.provenance as boolean | undefined,
  };
}
