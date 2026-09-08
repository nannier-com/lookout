/**
 * The web capture engine: one chromium, one page, walking
 * targets x routes x form factors x schemes x states, writing PNGs and shot
 * records with deterministic findings attached.
 *
 * Scheme mechanisms:
 *   emulate    page.emulateMedia({ colorScheme }) (default; apps honoring
 *              prefers-color-scheme)
 *   url-param  re-navigate with ?<param>=<scheme>
 *   recipe     config's exported setScheme(page, scheme) does it in-page
 *
 * The engine fails loud per route (recorded in run.failures) and continues;
 * a silent mislabeled capture is the one unforgivable failure mode.
 */
import { chromium, type Browser } from "playwright";
import {
  DEFAULT_VIEWPORTS,
  DEVICE_SCALE_FACTOR,
  FORM_FACTORS,
  type FormFactor,
  type ResolvedConfig,
  type RunRecord,
  type Scheme,
  type ShotRecord,
} from "../types.js";
import type { ResolvedTarget } from "../targets.js";
import { attachConsoleCollector } from "./checks.js";
import { markIndicatorReadback, markSchemeMismatches } from "./web-page.js";
import { captureRoute } from "./web-route.js";
import type { RouteHarvest, RoutePlan } from "../navigate/store.js";
import type { StaleStamp } from "../freshness.js";
import { nowIso } from "../util.js";

export interface WebCaptureOptions {
  formFactors: FormFactor[];
  schemes: Scheme[];
  /**
   * "route" = the accessibility scan at every form factor at rest, a violation
   * filed at the widest form factor that shows it and, at narrower ones, only
   * the nodes the wider layouts did not; "all" = every violation on every
   * form factor's rest shot; "off".
   */
  axe: "route" | "all" | "off";
  axeContrast: boolean;
  /** Extra settle after load, ms. */
  settleMs: number;
  /** Capture state recipes named on routes ("all"), or none ("off"). */
  states: "all" | "off";
  headless: boolean;
  /** Per-shot rendering-provenance sidecars; on unless config or flag opts out. */
  provenance: boolean;
  /** Per-shot accessibility-tree sidecars; on unless config or flag opts out. */
  aria: boolean;
  /**
   * The clipped-content measurement. On unless --no-edge-clip says otherwise:
   * it costs one page.evaluate and no model money, and what it measures is the
   * kind of defect a judge can only guess at.
   */
  edgeClip: boolean;
  runId: string;
  /**
   * Targets whose served build looked older than the source when the run
   * started, so the run records its own doubt. Absent when there was no reason
   * to doubt it, which keeps a clean run's flags clean.
   */
  staleBuild?: StaleStamp[];
  onProgress?: (line: string) => void;
  /**
   * Called as each shot lands, not at the end of the run. Anything watching a
   * capture live needs the record while the capture is still going.
   */
  onShot?: (shot: ShotRecord) => void;
  /**
   * Navigation discovery, when the config enables it: cached plans to execute
   * (keyed by target|route) and the sink each route's fresh affordance
   * harvest lands in. Absent = no harvesting, no synthesized states.
   */
  navigation?: {
    plans: ReadonlyMap<string, RoutePlan>;
    onHarvest: (routeKey: string, harvest: RouteHarvest) => void;
  };
}

export interface WebCaptureResult {
  run: RunRecord;
  shots: ShotRecord[];
}

export async function captureWeb(
  resolved: ResolvedConfig,
  targets: ResolvedTarget[],
  opts: WebCaptureOptions,
): Promise<WebCaptureResult> {
  const { config } = resolved;
  const startedAt = nowIso();
  const failures: RunRecord["failures"] = [];
  const shots: ShotRecord[] = [];
  const progress = opts.onProgress ?? (() => {});

  const viewports: Record<FormFactor, { width: number; height: number }> = {
    ...DEFAULT_VIEWPORTS,
    ...(config.viewports ?? {}),
  };
  // Walk order, widest first, whatever order the caller listed: the judge sees
  // the full layout before its scaled-down variants (see FORM_FACTORS).
  const formFactors = FORM_FACTORS.filter((f) => opts.formFactors.includes(f));

  const browser: Browser = await chromium.launch({ headless: opts.headless });
  try {
    const context = await browser.newContext({
      viewport: viewports[formFactors[0] ?? "desktop"],
      reducedMotion: "reduce",
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });
    const page = await context.newPage();
    const collector = attachConsoleCollector(page);

    for (const target of targets) {
      if (target.def.signIn) {
        try {
          progress(`signing in to ${target.def.name}`);
          await target.def.signIn(page);
        } catch (e) {
          // Every route on this target would now photograph a signed-out app
          // under a signed-in label, so skip the target rather than mislabel it.
          const message = (e as Error).message.slice(0, 500);
          failures.push({ target: target.def.name, route: "*", step: "signIn", message });
          progress(`FAIL ${target.def.name} signIn: ${message.slice(0, 200)}`);
          continue;
        }
      }
      for (const route of target.routes) {
        try {
          await captureRoute(resolved, target, route, page, {
            ...opts,
            formFactors,
            viewports,
            shots,
            collectorDrain: () => collector.drain(),
            progress,
          });
        } catch (e) {
          failures.push({
            target: target.def.name,
            route: route.path,
            step: "route",
            message: (e as Error).message.slice(0, 500),
          });
          progress(`FAIL ${target.def.name}${route.path}: ${(e as Error).message.slice(0, 200)}`);
          // A wedged page poisons every later route; recover with a clean slate.
          try {
            await page.goto("about:blank", { timeout: 5000 });
          } catch {}
        }
      }
    }
    collector.dispose();
    await context.close();
  } finally {
    await browser.close();
  }

  markIndicatorReadback(shots);
  markSchemeMismatches(shots);

  return {
    run: {
      id: opts.runId,
      kind: "web",
      startedAt,
      finishedAt: nowIso(),
      flags: {
        formFactors: opts.formFactors,
        schemes: opts.schemes,
        axe: opts.axe,
        states: opts.states,
        settleMs: opts.settleMs,
        navigation: !!opts.navigation,
        // Only when there was something to doubt: a flag that is always
        // present stops being read.
        ...(opts.staleBuild && opts.staleBuild.length > 0
          ? { staleBuild: opts.staleBuild }
          : {}),
      },
      failures,
      skips: [],
    },
    shots,
  };
}

