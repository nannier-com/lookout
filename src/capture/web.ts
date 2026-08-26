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
import { chromium, type Browser, type Locator, type Page } from "playwright";
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

function schemeUrl(resolved: ResolvedConfig, routeUrl: string, scheme: Scheme): string {
  const mode = resolved.config.scheme;
  if (mode?.mode !== "url-param") return routeUrl;
  const u = new URL(routeUrl);
  u.searchParams.set(mode.param, scheme);
  return u.toString();
}

async function setScheme(resolved: ResolvedConfig, page: Page, scheme: Scheme): Promise<void> {
  const mode = resolved.config.scheme ?? { mode: "emulate" as const };
  if (mode.mode === "emulate") {
    await page.emulateMedia({ colorScheme: scheme });
  } else if (mode.mode === "recipe") {
    await resolved.config.setScheme!(page, scheme);
  }
  // url-param is handled in the navigation URL.
}

async function settle(page: Page, settleMs: number): Promise<void> {
  // Fonts first (framework splash gates render nothing until they resolve),
  // then two frames so layout from late effects lands, then the buffer.
  await page
    .evaluate(async () => {
      const d = document as Document & { fonts?: { ready: Promise<unknown> } };
      if (d.fonts?.ready) await d.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })
    .catch(() => {});
  await page.waitForTimeout(settleMs);
}

async function captureRoute(
  resolved: ResolvedConfig,
  target: ResolvedTarget,
  route: ResolvedRoute,
  page: Page,
  ctx: RouteCtx,
): Promise<void> {
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
        let animated = false;
        if (stateName === "rest" && formFactor === ctx.formFactors[0] && scheme === ctx.schemes[0]) {
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
          capturedAt: nowIso(),
          runId: ctx.runId,
          deterministicFindings: findings,
        });
        ctx.progress(
          `shot ${shotId(axes)}${findings.length ? `  (${findings.length} finding${findings.length === 1 ? "" : "s"})` : ""}`,
        );

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

async function resolveElement(page: Page, selector: string | undefined): Promise<Locator | null> {
  if (!selector) return null;
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 10_000 });
  return loc;
}

/**
 * Scheme read-back: when the dark and light shots of the same route, state,
 * and form factor are byte-identical, the app ignored the configured scheme
 * mechanism and one label is a lie. The capture-ui lesson: never trust a
 * scheme switch without reading it back. Filed on the light shot as a warning
 * (a page can legitimately look near-identical, but byte-identical means the
 * mechanism did nothing).
 */
function markSchemeMismatches(shots: ShotRecord[]): void {
  const byKey = new Map<string, ShotRecord[]>();
  for (const s of shots) {
    const key = [s.platform, s.target, s.route, s.state, s.formFactor].join("|");
    const arr = byKey.get(key) ?? [];
    arr.push(s);
    byKey.set(key, arr);
  }
  for (const group of byKey.values()) {
    const dark = group.find((s) => s.scheme === "dark");
    const light = group.find((s) => s.scheme === "light");
    if (dark && light && dark.hash === light.hash) {
      light.deterministicFindings.push({
        type: "scheme-mismatch",
        severity: "warning",
        message:
          "dark and light captures are byte-identical; the app ignored the scheme mechanism " +
          "(configure scheme: url-param or a setScheme recipe in .lookout/config.ts)",
      });
    }
  }
}
