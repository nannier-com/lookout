/**
 * Config loading and validation.
 *
 * A project declares its targets in `lookout.config.ts` at its root (or .js /
 * .mjs / .json). The TypeScript form is first-class because recipes are
 * functions; that is why the CLI runs under bun, which imports .ts natively.
 * Zero-config runs synthesize a one-target config from --url so lookout works
 * in any directory. Where the file is found, and where it is written, is
 * `config-locate.ts` and `config-write.ts`; this file loads it.
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LookoutError, type LookoutConfig, type ResolvedConfig } from "./types.js";
import { CONFIG_FILENAME, LOOKOUT_DIR, locateConfig, projectDirFor } from "./config-locate.js";
import { isLocalUrl } from "./util.js";

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
    path = locateConfig(cwd)?.path ?? null;
  }

  if (!path) {
    throw new LookoutError(
      `no ${CONFIG_FILENAME} found here or in any parent directory`,
      "run `lookout init` to write one, or pass --url for a zero-config run",
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

  const projectDir = projectDirFor(path);
  return {
    config,
    configPath: path,
    projectDir,
    project: config.project ?? basename(projectDir),
  };
}

export { validateConfig } from "./config-validate.js";
import { validateConfig } from "./config-validate.js";


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

/**
 * The project's own lookout directory: the backlog, the issue folders, the
 * ledger, the skill amendments. The durable record of what lookout found,
 * which belongs to the project.
 */
export function lookoutDir(resolved: ResolvedConfig): string {
  return join(resolved.projectDir, LOOKOUT_DIR);
}

/**
 * The capture workspace: screenshots, the capture report, the run log, the
 * contact sheet.
 *
 * Inside the project's own `.lookout/`, which is gitignored, so it travels
 * with the checkout it describes and with nothing else. It is still working
 * state one capture rebuilds, which is why it is a directory of its own
 * rather than loose beside the backlog: the pixels worth keeping are copied
 * into the issue folders the moment an issue is filed, and everything here
 * can be deleted without costing the project a defect.
 *
 * `workspace`, not `evidence`: `.lookout/evidence/` is the pre-0.35 store
 * that `backlog.ts` and `issues/frames.ts` still adopt from, and one name for
 * both would make a live report indistinguishable from an inherited one.
 */
export function evidenceDir(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), WORKSPACE_DIR);
}

/** The workspace's directory name inside `.lookout/`. */
export const WORKSPACE_DIR = "workspace";
