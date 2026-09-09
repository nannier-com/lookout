/**
 * One route's capture: the form factor x scheme x state walk, the recipes,
 * and navigation discovery's hooks (harvest, synthesized states,
 * link-verification clicks). Split from web.ts, which owns the browser and
 * the target loop, and from web-shot.ts, which owns one photograph.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Page } from "playwright";
import type { FormFactor, ResolvedConfig, Scheme, ShotRecord, StateRecipe } from "../types.js";
import type { ResolvedRoute, ResolvedTarget } from "../targets.js";
import type { WebCaptureOptions } from "./web.js";
import type { DeterministicFinding } from "../types.js";
import type { AxeSeen } from "./axe.js";
import { shootCell } from "./web-shot.js";
import { schemeUrl, setScheme, settle } from "./web-page.js";
import { harvestRoute } from "../navigate/harvest.js";
import { NavSkip, runNavChecks, synthStates, type SynthesizedStates } from "../navigate/execute.js";
import { routeKey, type RouteHarvest } from "../navigate/store.js";
import { sha256 } from "../util.js";

/**
 * One state to capture instead of the route's own list: what a screen walk
 * asks for. The rest state is `{ state: "rest", recipe: null }`; a screen
 * reached by recorded clicks is its own name with the replay as the recipe.
 * Config recipes and navigation plans are not consulted for such a call:
 * the caller is naming exactly one view, and its siblings are other calls.
 */
export interface OnlyState {
  state: string;
  recipe: StateRecipe | null;
  /** What was clicked to reach it, and what that was expected to do, for the shot record. */
  affordance?: { selector: string; role: string; name: string; href: string | null; outcome: string };
}

export interface RouteCtx extends WebCaptureOptions {
  formFactors: FormFactor[];
  viewports: Record<FormFactor, { width: number; height: number }>;
  shots: ShotRecord[];
  collectorDrain: () => DeterministicFinding[];
  progress: (line: string) => void;
  only?: OnlyState;
}

export async function captureRoute(
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

  const states: [string, StateRecipe | null][] = ctx.only
    ? [[ctx.only.state, ctx.only.recipe]]
    : [["rest", null]];
  if (!ctx.only && ctx.states === "all") {
    for (const name of route.states) {
      const recipe = resolved.config.states?.[name];
      if (!recipe) {
        throw new Error(`route ${route.path} references unknown state "${name}"`);
      }
      states.push([name, recipe]);
    }
  }

  // Navigation discovery: the cached plan for this route, executed against
  // the fresh harvest (which does not exist until the first rest shot, so
  // synthesized states are appended mid-iteration; rest is always first).
  const plan =
    route.navigation !== false && !ctx.only
      ? ctx.navigation?.plans.get(routeKey(target.def.name, route.path))
      : undefined;
  let synth: SynthesizedStates | null = null;
  let freshHarvest: RouteHarvest | null = null;
  // A single named state carries what reached it the way a planned state does.
  const onlySynth: SynthesizedStates | null = ctx.only?.affordance
    ? {
        states: [],
        sessionDestructive: new Set(),
        skipAt: new Map(),
        interaction: new Map(),
        suppressDesign: new Set(ctx.only.affordance.outcome === "navigation" ? [ctx.only.state] : []),
        affordances: new Map([[ctx.only.state, ctx.only.affordance]]),
      }
    : null;

  // What the scan has filed on this route, per scheme, so a narrower form
  // factor adds only what is new.
  const axeSeen = new Map<Scheme, AxeSeen>();
  const reload = async (scheme: Scheme): Promise<void> => {
    await page.goto(schemeUrl(resolved, route.url, scheme), { waitUntil: "load", timeout: 45_000 });
    await settle(page, ctx.settleMs);
  };
  for (const scheme of ctx.schemes) {
    let navigated = false;
    for (const formFactor of ctx.formFactors) {
      await page.setViewportSize(ctx.viewports[formFactor]);
      if (!navigated) {
        await setScheme(resolved, page, scheme);
        await reload(scheme);
        navigated = true;
      } else {
        await settle(page, ctx.settleMs);
      }

      for (const [stateName, recipe] of states) {
        // State recipes run at every requested form factor: overlays and
        // drawers are exactly where narrow layouts break.
        if (recipe && synth?.skipAt.get(stateName)?.has(formFactor)) {
          ctx.progress(`nav state ${stateName} skipped at ${formFactor}: hover is not a phone interaction`);
          continue;
        }
        if (recipe) {
          try {
            await recipe.prepare(page);
            await page.waitForTimeout(250);
          } catch (e) {
            // Config recipes keep their route-fatal contract; a synthesized
            // state degrades to a skip (invisible here) or a capture-error on
            // this pass's rest shot, and the route carries on.
            if (!synth?.states.some(([n]) => n === stateName)) throw e;
            if (e instanceof NavSkip) {
              ctx.progress(`nav state ${stateName} skipped at ${formFactor}: ${(e as Error).message}`);
            } else {
              const msg = (e as Error).message.slice(0, 300);
              ctx.shots
                .find(
                  (s) =>
                    s.target === target.def.name && s.route === route.path &&
                    s.state === "rest" && s.formFactor === formFactor && s.scheme === scheme,
                )
                ?.deterministicFindings.push({
                  type: "capture-error",
                  severity: "warning",
                  message: `interaction state "${stateName}" failed: ${msg}`,
                  meta: { state: stateName },
                });
              ctx.progress(`nav state ${stateName} failed: ${msg.slice(0, 120)}`);
            }
            await reload(scheme);
            continue;
          }
        }

        await shootCell(resolved, target, route, page, ctx, {
          stateName,
          recipe,
          formFactor,
          scheme,
          axeSeen,
          synth: synth ?? onlySynth,
          designHash,
        });

        // Harvest once per route, at the first form factor and scheme, while
        // the page still sits at rest. A failed harvest costs discovery on
        // this route, never the route's shots.
        if (
          ctx.navigation &&
          !ctx.only &&
          route.navigation !== false &&
          stateName === "rest" &&
          formFactor === ctx.formFactors[0] &&
          scheme === ctx.schemes[0]
        ) {
          try {
            const nav = resolved.config.navigation ?? {};
            freshHarvest = await harvestRoute(page, { exclude: nav.exclude, include: nav.include });
            ctx.navigation.onHarvest(routeKey(target.def.name, route.path), freshHarvest);
            if (plan) {
              synth = synthStates({
                plan,
                harvest: freshHarvest,
                navigation: nav,
                recipeNames: route.states,
                routeUrl: route.url,
                routeElement: route.element ?? null,
              });
              states.push(...synth.states);
              if (synth.states.length > 0) {
                ctx.progress(`navigation: ${synth.states.length} planned state(s) on ${route.path}`);
              }
            }
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
            await reload(scheme);
          }
          // A session-killing click (sign out) leaves every later shot
          // photographing a logged-out app under a signed-in label; recover
          // the session the same way the run established it.
          if (synth?.sessionDestructive.has(stateName) && target.def.signIn) {
            ctx.progress(`re-signing in after ${stateName}`);
            await target.def.signIn(page);
            await reload(scheme);
          }
        }
      }
    }
  }

  // Link-verification clicks, once per route, after the shots are safely
  // taken: each configured-destination link must demonstrably navigate, and
  // a dead or erroring one files on this route's first rest shot.
  if (plan && freshHarvest && plan.checks.length > 0) {
    const url = schemeUrl(resolved, route.url, ctx.schemes[0]!);
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await settle(page, ctx.settleMs);
    const checkFindings = await runNavChecks({
      page,
      plan,
      harvest: freshHarvest,
      navigation: resolved.config.navigation ?? {},
      routeUrl: url,
    });
    checkFindings.push(...ctx.collectorDrain());
    ctx.shots
      .find(
        (s) =>
          s.target === target.def.name && s.route === route.path && s.state === "rest" &&
          s.formFactor === ctx.formFactors[0] && s.scheme === ctx.schemes[0],
      )
      ?.deterministicFindings.push(...checkFindings);
    if (checkFindings.length > 0) {
      ctx.progress(`navigation checks on ${route.path}: ${checkFindings.length} finding(s)`);
    }
  }
}
