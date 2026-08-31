/**
 * Config loading and validation.
 *
 * A project declares its targets in `.lookout/config.ts` (or .js / .json). The
 * TypeScript form is first-class because recipes are functions; that is why the
 * CLI runs under bun, which imports .ts natively. Zero-config runs synthesize a
 * one-target config from --url so lookout works in any directory.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_VIEWPORTS,
  LookoutError,
  type DesignSystemDeclaration,
  type FormFactor,
  type LookoutConfig,
  type ResolvedConfig,
  type RouteDef,
  type SchemeConfig,
  type TargetDef,
  type Viewport,
} from "./types.js";
import { findUp, isLocalUrl } from "./util.js";

const CONFIG_CANDIDATES = [
  ".lookout/config.ts",
  ".lookout/config.js",
  ".lookout/config.json",
];

export interface LoadOptions {
  /** Explicit config path from --config. */
  configPath?: string;
  /** Zero-config base URL from --url: REPLACES the config with one target. */
  url?: string;
  /**
   * Base URL from --base-url: OVERRIDES where the config's targets live,
   * keeping everything else about them.
   *
   * The difference from `url` is the whole point. `url` short-circuits the
   * config file entirely, so the routes, viewports, state recipes and signIn
   * hook a project wrote all vanish and the run captures "/" of one origin.
   * That is right for pointing lookout at something it knows nothing about, and
   * wrong for the common case of a configured project whose dev server came up
   * somewhere else today. This keeps the config and moves the targets.
   */
  baseUrl?: string;
  /** Search start directory (defaults to cwd). */
  cwd?: string;
}

/**
 * Move every target to a different origin, keeping everything else.
 *
 * A dev server that came up on another port does not make a project's routes,
 * viewports, recipes or sign-in hook wrong, so overriding the origin must not
 * discard them. Only the origin is replaced: any path a target's URL carried is
 * kept, because that is part of where the app is mounted rather than part of
 * which machine it is on.
 */
export function applyBaseUrl(config: LookoutConfig, baseUrl: string): void {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new LookoutError(
      `--base-url is not a valid URL: ${baseUrl}`,
      "give an origin such as http://localhost:3000",
    );
  }
  for (const t of config.targets) {
    const mounted = new URL(t.url).pathname.replace(/\/$/, "");
    t.url = (origin.origin + mounted).replace(/\/$/, "");
  }
}

export async function loadConfig(opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.url) {
    const config = validateConfig(
      { targets: [{ name: "app", url: opts.url }] },
      "(zero-config from --url)",
    );
    return {
      config,
      configPath: null,
      projectDir: cwd,
      project: config.project ?? basename(cwd),
    };
  }

  let path: string | null = null;
  if (opts.configPath) {
    path = isAbsolute(opts.configPath) ? opts.configPath : resolve(cwd, opts.configPath);
    if (!existsSync(path)) {
      throw new LookoutError(`config file not found: ${path}`);
    }
  } else {
    for (const rel of CONFIG_CANDIDATES) {
      path = findUp(rel, cwd);
      if (path) break;
    }
  }

  if (!path) {
    throw new LookoutError(
      "no .lookout/config.ts found here or in any parent directory",
      "run `lookout init` to scaffold one, or pass --url for a zero-config run",
    );
  }

  let raw: unknown;
  let setScheme: LookoutConfig["setScheme"];
  if (path.endsWith(".json")) {
    raw = JSON.parse(await Bun.file(path).text());
  } else {
    if (!process.versions.bun) {
      throw new LookoutError(
        "a TypeScript config needs the bun runtime",
        "run lookout via bun (the published bin already does): bunx @nannier-com/lookout",
      );
    }
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    raw = mod.default ?? mod.config;
    if (typeof mod.setScheme === "function") {
      setScheme = mod.setScheme as LookoutConfig["setScheme"];
    }
    if (raw === undefined) {
      throw new LookoutError(
        `${path} must export the config as default (or named \`config\`)`,
      );
    }
  }

  const config = validateConfig(raw, path);
  if (config.scheme?.mode === "recipe" && !setScheme) {
    throw new LookoutError(
      `${path} sets scheme.mode "recipe" but exports no setScheme(page, scheme)`,
    );
  }
  config.setScheme = setScheme;
  if (opts.baseUrl) applyBaseUrl(config, opts.baseUrl);

  const projectDir = dirname(dirname(path)); // .lookout/config.ts -> project root
  return {
    config,
    configPath: path,
    projectDir,
    project: config.project ?? basename(projectDir),
  };
}

// ---------------------------------------------------------------------------
// Validation. Hand-rolled with precise messages; the config is small enough
// that a schema library would cost more than it saves.
// ---------------------------------------------------------------------------

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
        fail(path, `viewports.${key}: unknown form factor (phone | tablet | desktop)`);
      }
      const v = (raw.viewports as Record<string, unknown>)[key];
      if (!isRecord(v) || typeof v.width !== "number" || typeof v.height !== "number") {
        fail(path, `viewports.${key} must be { width, height }`);
      }
      viewports[key as FormFactor] = { width: v.width, height: v.height };
    }
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

  return {
    project: typeof raw.project === "string" ? raw.project : undefined,
    targets: validTargets,
    viewports,
    scheme,
    states: raw.states as LookoutConfig["states"],
    element: typeof raw.element === "string" ? raw.element : undefined,
    rubric: typeof raw.rubric === "string" ? raw.rubric : undefined,
    neverFile: Array.isArray(raw.neverFile)
      ? raw.neverFile.filter((s): s is string => typeof s === "string")
      : undefined,
    designSystem,
    native: raw.native as LookoutConfig["native"],
    learn,
  };
}

// ---------------------------------------------------------------------------
// Safety: local targets by default.
// ---------------------------------------------------------------------------

export function assertTargetsAllowed(config: LookoutConfig, allowRemote: boolean): void {
  for (const t of config.targets) {
    if (!isLocalUrl(t.url) && !allowRemote) {
      throw new LookoutError(
        `target "${t.name}" points at a non-local URL (${t.url})`,
        "lookout only sweeps localhost by default; pass --allow-remote to override deliberately",
      );
    }
  }
}

/** Where evidence, reports, and the backlog live for a project. */
export function lookoutDir(resolved: ResolvedConfig): string {
  return join(resolved.projectDir, ".lookout");
}

export function evidenceDir(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "evidence");
}
