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

/**
 * Every web capture renders at this device scale. Beside the viewports rather
 * than inside the capture module so a document can state the pixel geometry
 * of a screenshot without loading playwright to ask.
 */
export const DEVICE_SCALE_FACTOR = 2;

/**
 * The form factors a web capture walks, in walk order: widest first, so the
 * judge, the accessibility scan and the navigation harvest see the full
 * layout before its scaled-down variants, and a run narrowed with
 * `--viewports` keeps the same relative order whatever order the flag listed.
 * `DEFAULT_VIEWPORTS` sizes them; a project can resize a form factor but never
 * add or remove one. The one list every default is read from: a second copy
 * anywhere is a bug.
 */
export const FORM_FACTORS: readonly FormFactor[] = ["desktop", "tablet", "phone"];

/** The colour schemes a capture walks, dark first, matching the judge's manifest order. */
export const SCHEMES: readonly Scheme[] = ["dark", "light"];

/** Every platform lookout can photograph, web first because it needs no device. */
export const PLATFORMS: readonly PlatformKind[] = ["web", "ios", "android"];

export interface RouteDef {
  /** Path under the target's base URL, e.g. "/settings". */
  path: string;
  /** Human name; defaults to the path. */
  name?: string;
  /** Names of state recipes (config.states) to additionally capture on this route. */
  states?: string[];
  /** CSS selector to element-screenshot instead of the full page, for this route. */
  element?: string;
  /**
   * Path to a design hand-off image for this route, resolved relative to the
   * config file. The judge reads it alongside every shot of this route and
   * compares one to one. It is a reference, not an authority: the judge rules
   * on each divergence by user impact and may find the build improved on the
   * hand-off.
   *
   * Point at an exported image of the artboard. lookout does not render a
   * hand-off itself: what a design tool exports is that tool's business, and
   * an image is the one form every design tool can produce.
   */
  design?: string;
  /** Per-route opt-out of navigation discovery (config.navigation). */
  navigation?: boolean;
  /** Per-route opt-out of rendering-provenance sidecars (config.provenance). */
  provenance?: boolean;
}

/**
 * Navigation discovery: lookout enumerates a route's interactive affordances
 * (buttons, links, CTAs), the plan-navigation skill curates them into a cached
 * plan, and capture executes the plan as first-class states the judges rule
 * on.
 *
 * WARNING: when enabled, lookout actuates every planned affordance by
 * default, destructive controls included; risk classification orders the
 * clicks, it does not prevent them. Point targets at a disposable
 * environment and list anything untouchable in `exclude`.
 */
export interface NavigationConfig {
  /**
   * Default false while the capability earns default-on (the shellScoping
   * precedent). This is the project committing to discovery for every run it
   * will ever have; `--navigation` is a single caller consenting to a single
   * run, and is what the ui's play button spends when the toggle beside it is
   * on. `--no-navigation` turns it off whichever said yes.
   */
  enabled?: boolean;
  /** Shot-producing interaction states the planner may pick per route. Default 5. */
  maxStatesPerRoute?: number;
  /** Link-verification clicks per route (no shots, no judging cost). Default 8. */
  maxChecksPerRoute?: number;
  /** CSS selectors or accessible-name substrings never actuated. */
  exclude?: string[];
  /** CSS selectors always offered to the planner. */
  include?: string[];
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
  /**
   * Drive the browser into an authenticated session, once, before any of this
   * target's routes are captured. The whole run shares one browser context, so
   * whatever cookies or storage this leaves behind persist for every later
   * shot.
   *
   * lookout knows nothing about how a project authenticates: it only calls
   * this. Projects put their own flow here (click a demo-account button, walk
   * an OAuth redirect, seed a token). If it throws, every route on the target
   * is skipped and recorded as a failure, because capturing a login screen and
   * labelling it a product route is the mislabeling this engine exists to
   * prevent.
   *
   * NEVER type real credentials here. Prefer an affordance the app already
   * exposes for testing, such as a demo-account button.
   */
  signIn?: (page: Page) => Promise<void>;
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
  /** Deep-link scheme, e.g. "myapp" for myapp:///settings. */
  deepLinkScheme: string;
  /** Bundle/application id, e.g. "com.example.myapp". */
  bundleId: string;
  /** Milliseconds to wait after opening a deep link before the screenshot. */
  settleMs?: number;
  /** Query param the app reads to force a scheme (e.g. "scheme"), if any. */
  appearanceParam?: string;
  /**
   * Human instruction printed when no device with the app is booted. lookout
   * never boots a simulator or installs an app; it tells the operator what to
   * do, in the project's own words (a `make ios-sim`, an `expo run:ios`).
   */
  startHint?: string;
  /**
   * The device kinds a run must have booted: default `["phone"]`. A kind
   * listed here and not booted stops the run, like a web target that is
   * down; a kind not listed is captured when it happens to be booted and
   * recorded as a skip when it is not.
   */
  devices?: DeviceKind[];
}

/** What a native device is for a form factor: a phone or a tablet. */
export type DeviceKind = Extract<FormFactor, "phone" | "tablet">;

export interface LookoutConfig {
  /** Project label used in reports. Defaults to the directory name. */
  project?: string;
  targets: TargetDef[];
  viewports?: Partial<Record<FormFactor, Viewport>>;
  /**
   * Which fold this project is judged in: "web" walks the three viewports,
   * "ios" and "android" walk the booted devices. Left out, lookout reads the
   * repository and the `native` block to decide (see project-kind.ts); set,
   * this is the whole answer and detection is not consulted. `--platforms`
   * still narrows or widens a single run.
   */
  platforms?: PlatformKind[];
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
  /**
   * Shell-scoped identity. When true, a finding the judge places in a shell
   * region (shell-nav, shell-header, shell-footer) is fingerprinted by that
   * region instead of by the route it was photographed on, and the
   * route-scoped records it supersedes fold into it as it is re-found: one
   * chrome defect becomes one finding, and an adjudication on it holds
   * everywhere. Transition flag: off by default for a release so regions
   * accumulate inspectably before any identity moves.
   */
  shellScoping?: boolean;
  /** Path (relative to the config file) of a project rubric extension, markdown. */
  rubric?: string;
  /** Extra never-file lines appended to the judge's exclusion list. */
  neverFile?: string[];
  /**
   * What this project is built out of, when the scan cannot work it out.
   *
   * lookout detects the design system by reading manifests and directory
   * layout, which covers a published kit, a vendored one, and a workspace
   * package the app imports. An in-house kit with none of those marks is
   * invisible to it, and guessing would be worse than asking: a wrongly named
   * kit sends every fix to the wrong repository.
   *
   * Anything declared here overrides what was detected, because a person who
   * has written down what their project uses has said something the scanner is
   * not entitled to argue with.
   */
  designSystem?: DesignSystemDeclaration;
  native?: {
    /** Which target's routes the native app mirrors (default: the first). */
    target?: string;
    ios?: NativeAppConfig;
    android?: NativeAppConfig;
  };
  /**
   * The automatic learning loop. `check` and `verify-fix` run `skills
   * improve` when this project's NEW signals cross the threshold, still
   * protected by the frozen-set replay gate. Off switches, because auto-spend
   * without one is a run people stop making: `auto: false` here,
   * `--no-improve` per run, and CI environments never auto-learn.
   */
  learn?: {
    /** Default true. */
    auto?: boolean;
    /** New signals needed before a run auto-learns. Default 3; a new by-design adjudication fires alone. */
    threshold?: number;
    /** Minimum hours between automatic improves. Default 24. */
    cooldownHours?: number;
  };
  /** Navigation discovery; see NavigationConfig for the click-everything warning. */
  navigation?: NavigationConfig;
  /**
   * Knobs for the deterministic checks that need one.
   *
   * Only the checks that can be wrong about a project belong here. Most cannot
   * be: a console error is a console error. The clip check can, because a
   * project may deliberately render outside a box (a carousel track, a marquee)
   * and no measurement can tell that from a defect.
   *
   * NOT the same thing as `neverFile`, which speaks to the judges. These select
   * what is measured; a measurement lookout does take is never suppressed by a
   * rule written for a model.
   */
  checks?: {
    edgeClip?: {
      /** CSS selectors whose subtrees are exempt from the clip measurement. */
      ignore?: string[];
    };
  };
  /**
   * Per-shot rendering-provenance sidecars (which elements rendered where,
   * and which components and source files produced them, where the page's
   * dev tooling says). Default TRUE, a conscious departure from the
   * earn-default-on precedent navigation follows: the walk is passive and
   * read-only, spends no model money, costs milliseconds and a few tens of
   * KB, and a failure is swallowed without costing the shot.
   */
  provenance?: boolean;
}

/**
 * A project's own statement of what it is built from. Every field is optional:
 * declaring only `componentRoots` to correct a scan that found the kit but not
 * its source is a normal and useful thing to do.
 */
export interface DesignSystemDeclaration {
  /** What the kit is called. Used in issue documents and nowhere else. */
  name?: string;
  /**
   * Absolute or config-relative path to the kit's own package root. Naming it
   * is what turns "you use a design system" into "the fix goes here".
   */
  packageRoot?: string;
  /** Directories holding the kit's components, config-relative or absolute. */
  componentRoots?: string[];
  /** Import specifiers that mean "this came from the kit", e.g. "@acme/ui". */
  importPrefixes?: string[];
  /** Files holding design tokens: colours, spacing, type scale. */
  tokenFiles?: string[];
  /** Where the kit documents itself, for the issue document to point at. */
  docs?: string;
  /**
   * False when the kit is consumed from a registry and is not this
   * repository's to edit. Defaults to true when a packageRoot is declared,
   * because declaring a path to something you cannot edit would be pointless.
   */
  editable?: boolean;
}

/** A LookoutConfig plus where it came from, after validation. */
export interface ResolvedConfig {
  config: LookoutConfig;
  /** Absolute path of the config file, or null for zero-config runs. */
  configPath: string | null;
  /** The project's root: `.lookout/` lives here, and the capture workspace is keyed off it. */
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
    | "edge-clipped"
    | "box-collision"
    | "axe-violation"
    | "blank-shot"
    | "capture-error"
    | "scheme-mismatch"
    | "stale-frame"
    | "off-origin"
    | "dead-interaction";
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
  /**
   * Horizontal scrollers in this frame, and how much of each is off screen.
   *
   * Context, never a finding: content inside one is reachable, and without
   * knowing that, a judge reading a table whose last column is cut off at the
   * frame's edge cannot tell a defect from a scroll. Deliberately NOT part of
   * the group hash, the same rule `animated` follows: it describes how the
   * page is built, not what it looks like, so it must never re-judge anything
   * on its own.
   */
  scrollers?: { path: string; tag: string; width: number; hiddenWidth: number }[];
  /** Absolute path of this route's design hand-off image, when one is configured. */
  design?: string;
  /**
   * sha256 of that image's bytes at capture time, "missing" when the
   * configured file was absent. A judge input: it enters the view group's
   * ledger hash, so swapping the hand-off re-judges the views that point at
   * it. Absent exactly when `design` is absent, so design-free groups keep
   * their existing hashes.
   */
  designHash?: string;
  /**
   * Evidence-relative path of the shot's rendering-provenance sidecar, when
   * one was captured. NOT a judge input: it enters no ledger hash and no
   * fingerprint, so its presence or absence never re-judges anything.
   */
  provenance?: string;
  /**
   * How the view was photographed, for whoever has to put the same screen in
   * front of themselves. Recorded by web capture; older reports carry none.
   */
  url?: string;
  /** Where the page actually landed, when it differs from `url`. */
  finalUrl?: string;
  viewport?: Viewport;
  dpr?: number;
  schemeMechanism?: "emulate" | "url-param" | "recipe";
  /** The selector that was framed, when the shot is of one element. */
  element?: string;
  /** The simulator or emulator a native shot was taken on: its name and the id lookout addressed it by. */
  device?: { id: string; name: string };
  /** What a state other than rest is, in the words of whoever planned it. */
  stateDescription?: string;
  /** What was clicked to reach a synthesized state, and what was expected. */
  stateAffordance?: { selector: string; role: string; name: string; href: string | null; outcome?: string };
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
