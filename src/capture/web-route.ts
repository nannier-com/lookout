/**
 * One route's capture: the form factor x scheme x state walk, the shot
 * records, and navigation discovery's hooks (harvest, synthesized states,
 * link-verification clicks). Split from web.ts, which owns the browser and
 * the target loop.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Page } from "playwright";
import type {
  DeterministicFinding,
  FormFactor,
  ResolvedConfig,
  ShotRecord,
  StateRecipe,
} from "../types.js";
import type { ResolvedRoute, ResolvedTarget } from "../targets.js";
import type { WebCaptureOptions } from "./web.js";
import {
  blankShotGuard,
  checkHorizontalOverflow,
  checkOffOrigin,
  detectAnimated,
} from "./checks.js";
import { runAxe } from "./axe.js";
import { shotId, writeShotFile, writeShotSidecar, type ShotAxes } from "./store.js";
import { attachProvenance, buildSidecar, collectProvenanceInPage, selectorsOf } from "./provenance.js";
import { resolveElement, schemeUrl, setScheme, settle } from "./web-page.js";
import { harvestRoute } from "../navigate/harvest.js";
import { NavSkip, runNavChecks, synthStates, type SynthesizedStates } from "../navigate/execute.js";
import { routeKey, type RouteHarvest } from "../navigate/store.js";
import { nowIso, sha256 } from "../util.js";
import { DEVICE_SCALE_FACTOR } from "../types.js";

export interface RouteCtx extends WebCaptureOptions {
  formFactors: FormFactor[];
  viewports: Record<FormFactor, { width: number; height: number }>;
  shots: ShotRecord[];
  collectorDrain: () => DeterministicFinding[];
  progress: (line: string) => void;
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

  // Navigation discovery: the cached plan for this route, executed against
  // the fresh harvest (which does not exist until the first rest shot, so
  // synthesized states are appended mid-iteration; rest is always first).
  const plan =
    route.navigation !== false
      ? ctx.navigation?.plans.get(routeKey(target.def.name, route.path))
      : undefined;
  let synth: SynthesizedStates | null = null;
  let freshHarvest: RouteHarvest | null = null;

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
            await page.goto(schemeUrl(resolved, route.url, scheme), { waitUntil: "load", timeout: 45_000 });
            await settle(page, ctx.settleMs);
            continue;
          }
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

        const landed = page.url();
        findings.push(...checkOffOrigin(landed, target.def.url));
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
        const pngHash = sha256(png);
        const capturedAt = nowIso();

        // Rendering provenance, while the page still shows what the PNG shows.
        // A failed walk costs the sidecar, never the shot.
        let provenanceRel: string | undefined;
        if (ctx.provenance && route.provenance !== false) {
          try {
            const raw = await page.evaluate(collectProvenanceInPage, {
              rootSelector: element ? elementSel ?? null : null,
              maxElements: 800,
              // The deterministic findings' own selectors, joined against the
              // live DOM while it still shows what the PNG shows.
              resolve: findings.flatMap(selectorsOf),
            });
            const sidecar = buildSidecar(raw, {
              id: shotId(axes),
              runId: ctx.runId,
              capturedAt,
              hash: pngHash,
              origin: element ? "element" : "document",
              image: { width: meta.width ?? 0, height: meta.height ?? 0 },
            });
            attachProvenance(findings, sidecar);
            provenanceRel = (await writeShotSidecar(resolved, axes, sidecar)).rel;
          } catch (e) {
            ctx.progress(
              `provenance failed on ${shotId(axes)}: ${(e as Error).message.slice(0, 120)}`,
            );
          }
        }

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
          hash: pngHash,
          bytes: png.byteLength,
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          animated,
          ...(provenanceRel ? { provenance: provenanceRel } : {}),
          // A navigation state's pixels show another page; the route's design
          // reference describes its rest render, so it must not ride along or
          // design-parity would judge the wrong screen against it.
          design: synth?.suppressDesign.has(stateName) ? undefined : route.design,
          ...(designHash && !synth?.suppressDesign.has(stateName) ? { designHash } : {}),
          // How this view was photographed, for whoever has to put the same
          // screen in front of themselves: none of it was recorded before, and
          // a document could only reconstruct it from a config that may have
          // changed since.
          url: schemeUrl(resolved, route.url, scheme),
          ...(landed !== schemeUrl(resolved, route.url, scheme) ? { finalUrl: landed } : {}),
          viewport: ctx.viewports[formFactor],
          dpr: DEVICE_SCALE_FACTOR,
          schemeMechanism: resolved.config.scheme?.mode ?? "emulate",
          ...(elementSel ? { element: elementSel } : {}),
          ...(recipe?.description ? { stateDescription: recipe.description } : {}),
          ...(synth?.affordances.get(stateName) ? { stateAffordance: synth.affordances.get(stateName) } : {}),
          capturedAt,
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
            freshHarvest = await harvestRoute(page, { exclude: nav.exclude, include: nav.include });
            ctx.navigation.onHarvest(routeKey(target.def.name, route.path), freshHarvest);
            if (plan) {
              synth = synthStates({
                plan,
                harvest: freshHarvest,
                navigation: nav,
                recipeNames: route.states,
                routeUrl: route.url,
              });
              states.push(...synth.states);
              if (synth.states.length > 0) {
                ctx.progress(
                  `navigation: ${synth.states.length} planned state(s) on ${route.path}`,
                );
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
            await page.goto(schemeUrl(resolved, route.url, scheme), {
              waitUntil: "load",
              timeout: 45_000,
            });
            await settle(page, ctx.settleMs);
          }
          // A session-killing click (sign out) leaves every later shot
          // photographing a logged-out app under a signed-in label; recover
          // the session the same way the run established it.
          if (synth?.sessionDestructive.has(stateName) && target.def.signIn) {
            ctx.progress(`re-signing in after ${stateName}`);
            await target.def.signIn(page);
            await page.goto(schemeUrl(resolved, route.url, scheme), { waitUntil: "load", timeout: 45_000 });
            await settle(page, ctx.settleMs);
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
