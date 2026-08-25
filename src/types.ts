/**
 * Shared types for lookout. Everything the config file, the capture engine, the
 * judge, and the backlog agree on lives here so the contract is one import away.
 */
import type { Page } from "playwright";

export type FormFactor = "phone" | "tablet" | "desktop";
export type Scheme = "dark" | "light";
export type PlatformKind = "web" | "ios" | "android";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Viewport {
  width: number;
  height: number;
}

/** Default desktop-first viewport presets; projects can override per key. */
export const DEFAULT_VIEWPORTS: Record<FormFactor, Viewport> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  phone: { width: 390, height: 844 },
};

export interface RouteDef {
  /** Path under the target's base URL, e.g. "/components/button". */
  path: string;
  /** Human name; defaults to the path. */
  name?: string;
  /** Names of state recipes (config.states) to additionally capture on this route. */
  states?: string[];
  /** CSS selector to element-screenshot instead of the full page, for this route. */
  element?: string;
}

export interface TargetDef {
  /** Short handle used in flags (--targets) and finding fingerprints. */
  name: string;
  /** Base URL. Localhost by default; anything else needs --allow-remote. */
  url: string;
  /** Routes to capture. Strings are shorthand for { path }. Defaults to ["/"]. */
  routes?: (string | RouteDef)[];
  /** Path polled for readiness (defaults to "/"). */
  readyPath?: string;
  /**
   * Human instruction printed when the target is down. lookout NEVER starts
   * services itself; it tells the operator what to start.
   */
  startHint?: string;
  /**
   * Query params appended to every route URL (e.g. { surface: "solid" } to
   * pin an app mode for capture). The scheme url-param rides on top.
   */
  query?: Record<string, string>;
}

/** How a target switches color scheme. */
export type SchemeConfig =
  /** Default: Playwright prefers-color-scheme emulation. */
  | { mode: "emulate" }
  /** Append ?<param>=dark|light to every route URL. */
  | { mode: "url-param"; param: string }
  /** The config module exports setScheme(page, scheme) doing it in-page. */
  | { mode: "recipe" };

export interface StateRecipe {
  description?: string;
  /**
   * Drive the page into the state (open an overlay, switch an in-app form
   * factor, expand a row). Runs after navigation and scheme setup. Must leave
   * the page in the state to photograph; lookout shoots immediately after.
   */
  prepare: (page: Page) => Promise<void>;
  /**
   * Optional cleanup returning the page to rest (Escape, close). When absent,
   * lookout reloads between states.
   */
  restore?: (page: Page) => Promise<void>;
  /**
   * CSS selector to element-screenshot for this state. Overrides the route's
   * element; pass null to force a FULL-PAGE shot (needed when the state
   * renders outside the route's element, e.g. a portaled overlay).
   */
  element?: string | null;
}

export interface NativeAppConfig {
  /** Deep-link scheme, e.g. "canvas" for canvas:///components/button. */
  deepLinkScheme: string;
  /** Bundle/application id, e.g. "com.nannier.canvas". */
  bundleId: string;
  /** Milliseconds to wait after opening a deep link before the screenshot. */
  settleMs?: number;
  /** Query param the app reads to force a scheme (e.g. "scheme"), if any. */
  appearanceParam?: string;
}

export interface LookoutConfig {
  /** Project label used in reports. Defaults to the directory name. */
  project?: string;
  targets: TargetDef[];
  viewports?: Partial<Record<FormFactor, Viewport>>;
  scheme?: SchemeConfig;
  /**
   * When the scheme mode is "recipe", the config module must also export
   * setScheme(page, scheme). Held here after loading.
   */
  setScheme?: (page: Page, scheme: Scheme) => Promise<void>;
  /** Named interaction recipes routes can reference via states: ["name"]. */
  states?: Record<string, StateRecipe>;
  /** Default CSS selector to element-screenshot instead of the full page. */
  element?: string;
  /** Path (relative to the config file) of a project rubric extension, markdown. */
  rubric?: string;
  /** Extra never-file lines appended to the judge's exclusion list. */
  neverFile?: string[];
  native?: {
    /** Which target's routes the native app mirrors (default: the first). */
    target?: string;
    ios?: NativeAppConfig;
    android?: NativeAppConfig;
  };
}

/** A LookoutConfig plus where it came from, after validation. */
export interface ResolvedConfig {
  config: LookoutConfig;
  /** Absolute path of the config file, or null for zero-config runs. */
  configPath: string | null;
  /** Directory findings/evidence are rooted in (.lookout/ lives here). */
  projectDir: string;
  project: string;
}

// ---------------------------------------------------------------------------
// Evidence (capture output) contract, shared with the judge and backlog.
// ---------------------------------------------------------------------------

export type FindingChannel = "deterministic" | "ai" | "code";

export interface DeterministicFinding {
  type:
    | "console-error"
    | "page-error"
    | "request-failed"
    | "horizontal-overflow"
    | "axe-violation"
    | "blank-shot"
    | "capture-error"
    | "scheme-mismatch"
    | "stale-frame";
  severity: "error" | "warning" | "info";
  message: string;
  meta?: Record<string, unknown>;
}

export interface ShotRecord {
  /** Stable id: target/route/state/platform/formFactor/scheme. */
  id: string;
  target: string;
  route: string;
  routeName: string;
  state: string; // "rest" or a recipe name
  platform: PlatformKind;
  formFactor: FormFactor;
  scheme: Scheme;
  /** Path relative to the evidence directory. */
  path: string;
  /** sha256 of the PNG bytes; the judge cache key. */
  hash: string;
  bytes: number;
  width: number;
  height: number;
  /** True when two samples 400ms apart differed (hash caching unreliable). */
  animated: boolean;
  capturedAt: string;
  runId: string;
  deterministicFindings: DeterministicFinding[];
}

export interface RunRecord {
  id: string;
  kind: "web" | "native";
  startedAt: string;
  finishedAt: string;
  flags: Record<string, unknown>;
  failures: { target: string; route: string; step: string; message: string }[];
  skips: { platform: PlatformKind; reason: string }[];
}

export interface CaptureReport {
  version: 1;
  project: string;
  createdAt: string;
  updatedAt: string;
  runs: RunRecord[];
  shots: ShotRecord[];
}

/** Thrown for operator-facing failures; the CLI prints the message and exits 2. */
export class LookoutError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LookoutError";
  }
}
