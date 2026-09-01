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
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import {
  DEFAULT_VIEWPORTS,
  type DeterministicFinding,
  type FormFactor,
  type ResolvedConfig,
  type RunRecord,
  type Scheme,
  type ShotRecord,
  type StateRecipe,
} from "../types.js";
import type { ResolvedRoute, ResolvedTarget } from "../targets.js";
import {
  attachConsoleCollector,
  blankShotGuard,
  checkHorizontalOverflow,
  checkOffOrigin,
  detectAnimated,
  runAxe,
} from "./checks.js";
import { shotId, writeShotFile, type ShotAxes } from "./store.js";
import {
  markSchemeMismatches,
  resolveElement,
  schemeUrl,
  setScheme,
  settle,
} from "./web-page.js";
import { harvestRoute } from "../navigate/harvest.js";
import { routeKey, type RouteHarvest, type RoutePlan } from "../navigate/store.js";
import { nowIso, sha256 } from "../util.js";

export interface WebCaptureOptions {
  formFactors: FormFactor[];
  schemes: Scheme[];
  /** "route" = axe once per route x scheme at the widest form factor; "all" = every shot; "off". */
  axe: "route" | "all" | "off";
  axeContrast: boolean;
  /** Extra settle after load, ms. */
  settleMs: number;
  /** Capture state recipes named on routes ("all"), or none ("off"). */
  states: "all" | "off";
  headless: boolean;
  runId: string;
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
  // Desktop-first: judge the widest layout before its scaled-down variants.
  const order: FormFactor[] = ["desktop", "tablet", "phone"];
  const formFactors = order.filter((f) => opts.formFactors.includes(f));

  const browser: Browser = await chromium.launch({ headless: opts.headless });
  try {
    const context = await browser.newContext({
      viewport: viewports[formFactors[0] ?? "desktop"],
      reducedMotion: "reduce",
      deviceScaleFactor: 2,
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
      },
      failures,
      skips: [],
    },
    shots,
  };
}

// ---------------------------------------------------------------------------

interface RouteCtx extends WebCaptureOptions {
  formFactors: FormFactor[];
  viewports: Record<FormFactor, { width: number; height: number }>;
  shots: ShotRecord[];
  collectorDrain: () => DeterministicFinding[];
  progress: (line: string) => void;
}

async function captureRoute(
  resolved: ResolvedConfig,
  target: ResolvedTarget,
  route: ResolvedRoute,
  page: Page,
  ctx: RouteCtx,
): Promise<void> {
  // The hand-off image is a judge input: its bytes enter the view group's
  // ledger hash, so a swapped design re-judges the views that point at it.
  // A configured-but-missing file stamps "missing", a value, so it still
  // differs from having no design at all.
  const designHash = route.design
    ? existsSync(route.design)
      ? sha256(readFileSync(route.design))
      : "missing"
    : undefined;

  const states: [string, StateRecipe | null][] = [["rest", null]];
  if (ctx.states === "all") {
    for (const name of route.states) {
      const recipe = resolved.config.states?.[name];
      if (!recipe) {
        throw new Error(`route ${route.path} references unknown state "${name}"`);
      }
      states.push([name, recipe]);
    }
  }

  for (const scheme of ctx.schemes) {
    let navigated = false;
    for (const formFactor of ctx.formFactors) {
      await page.setViewportSize(ctx.viewports[formFactor]);
      if (!navigated) {
        await setScheme(resolved, page, scheme);
        await page.goto(schemeUrl(resolved, route.url, scheme), {
          waitUntil: "load",
          timeout: 45_000,
        });
        navigated = true;
      }
      await settle(page, ctx.settleMs);

      for (const [stateName, recipe] of states) {
        // State recipes run at every requested form factor: overlays and
        // drawers are exactly where narrow layouts break.
        if (recipe) {
          await recipe.prepare(page);
          await page.waitForTimeout(250);
        }

        // A recipe's element wins even when null (null = full page: portaled
        // overlays render outside the route's element).
        const elementSel =
          recipe && recipe.element !== undefined ? recipe.element : route.element;
        const element = await resolveElement(page, elementSel ?? undefined);
        const axes: ShotAxes = {
          target: target.def.name,
          route: route.path,
          state: stateName,
          platform: "web",
          formFactor,
          scheme,
        };

        const findings: DeterministicFinding[] = [];
        // Sampled once per route x state at the first form factor and scheme:
        // spinners and skeletons live inside state recipes, which the old
        // rest-only sampling never saw. Not per form factor or scheme, because
        // media-query-gated animation is rare and the flag no longer gates
        // money, only a context line in the judge prompt.
        let animated = false;
        if (formFactor === ctx.formFactors[0] && scheme === ctx.schemes[0]) {
          animated = await detectAnimated(page, element);
        }

        const png = element
          ? await element.screenshot({ animations: "disabled" })
          : await page.screenshot({ fullPage: true, animations: "disabled" });

        findings.push(...checkOffOrigin(page.url(), target.def.url));
        findings.push(...(await blankShotGuard(png)));
        findings.push(...(await checkHorizontalOverflow(page, element)));
        const axeHere =
          ctx.axe === "all" || (ctx.axe === "route" && formFactor === ctx.formFactors[0]);
        if (axeHere && stateName === "rest") {
          findings.push(...(await runAxe(page, elementSel ?? null, { contrast: ctx.axeContrast })));
        }
        findings.push(...ctx.collectorDrain());

        const { rel } = await writeShotFile(resolved, axes, png);
        const sharp = (await import("sharp")).default;
        const meta = await sharp(png).metadata();
        ctx.shots.push({
          id: shotId(axes),
          target: target.def.name,
          route: route.path,
          routeName: route.name,
          state: stateName,
          platform: "web",
          formFactor,
          scheme,
          path: rel,
          hash: sha256(png),
          bytes: png.byteLength,
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          animated,
          design: route.design,
          ...(designHash ? { designHash } : {}),
          capturedAt: nowIso(),
          runId: ctx.runId,
          deterministicFindings: findings,
        });
        ctx.onShot?.(ctx.shots[ctx.shots.length - 1]!);
        ctx.progress(
          `shot ${shotId(axes)}${findings.length ? `  (${findings.length} finding${findings.length === 1 ? "" : "s"})` : ""}`,
        );

        // Harvest once per route, at the first form factor and scheme, while
        // the page still sits at rest. A failed harvest costs discovery on
        // this route, never the route's shots.
        if (
          ctx.navigation &&
          route.navigation !== false &&
          stateName === "rest" &&
          formFactor === ctx.formFactors[0] &&
          scheme === ctx.schemes[0]
        ) {
          try {
            const nav = resolved.config.navigation ?? {};
            ctx.navigation.onHarvest(
              routeKey(target.def.name, route.path),
              await harvestRoute(page, { exclude: nav.exclude, include: nav.include }),
            );
          } catch (e) {
            ctx.progress(`harvest failed on ${route.path}: ${(e as Error).message.slice(0, 200)}`);
          }
        }

        if (recipe) {
          if (recipe.restore) {
            await recipe.restore(page);
            await page.waitForTimeout(150);
          } else {
            // No restore recipe: reload to guarantee a clean rest state.
            await page.goto(schemeUrl(resolved, route.url, scheme), {
              waitUntil: "load",
              timeout: 45_000,
            });
            await settle(page, ctx.settleMs);
          }
        }
      }
    }
  }
}

