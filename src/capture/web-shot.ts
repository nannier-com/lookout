/**
 * One cell of a route's capture: the page is already at the route, in the
 * scheme and at the form factor, and the state recipe (if any) has run. What
 * is left is the photograph, the measurements taken while the page still
 * shows what the PNG shows, the sidecars, and the record. Split from
 * web-route.ts, which owns the walk order and the recipes.
 */
import type { Locator, Page } from "playwright";
import type {
  DeterministicFinding,
  FormFactor,
  ResolvedConfig,
  Scheme,
  ShotRecord,
  StateRecipe,
} from "../types.js";
import type { ResolvedRoute, ResolvedTarget } from "../targets.js";
import type { SynthesizedStates } from "../navigate/execute.js";
import type { RouteCtx } from "./web-route.js";
import { blankShotGuard, checkHorizontalOverflow, checkOffOrigin, detectAnimated } from "./checks.js";
import { axeForShot, runTargetSize, type AxeSeen } from "./axe.js";
import { checkEdgeClipping, type ScrollerNote } from "./check-clip.js";
import { checkCollisions } from "./checks-collide.js";
import { shotId, writeShotFile, type ShotAxes } from "./store.js";
import { writeSidecars } from "./web-sidecars.js";
import { resolveElement, schemeUrl } from "./web-page.js";
import { nowIso, sha256 } from "../util.js";
import { DEVICE_SCALE_FACTOR } from "../types.js";

export interface ShotCell {
  stateName: string;
  recipe: StateRecipe | null;
  formFactor: FormFactor;
  scheme: Scheme;
  /** What the accessibility scan has filed on this route, per scheme. */
  axeSeen: Map<Scheme, AxeSeen>;
  /** Navigation discovery's synthesized states, when the route has a plan. */
  synth: SynthesizedStates | null;
  /** The route's design hand-off hash, computed once per route. */
  designHash: string | undefined;
}

/** Photograph the cell, measure it, write it, and push its record onto `ctx.shots`. */
export async function shootCell(
  resolved: ResolvedConfig,
  target: ResolvedTarget,
  route: ResolvedRoute,
  page: Page,
  ctx: RouteCtx,
  cell: ShotCell,
): Promise<ShotRecord> {
  const { stateName, recipe, formFactor, scheme, synth } = cell;
  // A recipe's element wins even when null (null = full page: portaled
  // overlays render outside the route's element).
  const elementSel = recipe && recipe.element !== undefined ? recipe.element : route.element;
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
  const scrollers = await measureClipping(resolved, page, element, elementSel ?? null, axes, ctx, findings);
  // The accessibility scan at every form factor, at rest. "route" files
  // a violation at the widest form factor that shows it and, at each
  // narrower one, only the nodes the wider layouts did not (a hamburger
  // button with no name, content a media query pushed off screen);
  // "all" files every violation on every form factor.
  if (ctx.axe !== "off" && stateName === "rest") {
    const seen = ctx.axe === "route" ? cell.axeSeen.get(scheme) ?? new Map<string, Set<string>>() : null;
    if (seen) cell.axeSeen.set(scheme, seen);
    findings.push(...(await axeForShot(page, elementSel ?? null, { contrast: ctx.axeContrast, seen })));
  }
  // Control size, at the width where a finger is the pointer. axe ships
  // this rule DISABLED, so the scan above never runs it however many form
  // factors it reaches; selecting it by name here is the only thing that
  // makes it run at all. Removing this hook stops target-size entirely.
  if (ctx.axe !== "off" && formFactor === "phone" && stateName === "rest") {
    findings.push(...(await runTargetSize(page, elementSel ?? null)));
  }
  findings.push(...ctx.collectorDrain());

  const { rel } = await writeShotFile(resolved, axes, png);
  const sharp = (await import("sharp")).default;
  const meta = await sharp(png).metadata();
  const pngHash = sha256(png);
  const capturedAt = nowIso();

  // What goes beside the shot: the accessibility tree and the rendering
  // provenance, both taken while the page still shows what the PNG shows,
  // and both costing only themselves when they fail.
  const sidecars = await writeSidecars({
    resolved,
    page,
    element,
    elementSelector: elementSel ?? null,
    axes,
    runId: ctx.runId,
    capturedAt,
    pngHash,
    image: { width: meta.width ?? 0, height: meta.height ?? 0 },
    findings,
    want: {
      provenance: ctx.provenance && route.provenance !== false,
      aria: ctx.aria,
    },
    progress: ctx.progress,
  });

  const url = schemeUrl(resolved, route.url, scheme);
  const suppressDesign = synth?.suppressDesign.has(stateName) ?? false;
  const shot: ShotRecord = {
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
    ...(scrollers.length > 0 ? { scrollers } : {}),
    ...(sidecars.provenance ? { provenance: sidecars.provenance } : {}),
    ...(sidecars.aria ? { aria: sidecars.aria } : {}),
    ...(sidecars.ariaHash ? { ariaHash: sidecars.ariaHash } : {}),
    // A navigation state's pixels show another page; the route's design
    // reference describes its rest render, so it must not ride along or
    // design-parity would judge the wrong screen against it.
    design: suppressDesign ? undefined : route.design,
    ...(cell.designHash && !suppressDesign ? { designHash: cell.designHash } : {}),
    // How this view was photographed, for whoever has to put the same
    // screen in front of themselves: none of it was recorded before, and
    // a document could only reconstruct it from a config that may have
    // changed since.
    url,
    ...(landed !== url ? { finalUrl: landed } : {}),
    viewport: ctx.viewports[formFactor],
    dpr: DEVICE_SCALE_FACTOR,
    schemeMechanism: resolved.config.scheme?.mode ?? "emulate",
    ...(elementSel ? { element: elementSel } : {}),
    ...(recipe?.description ? { stateDescription: recipe.description } : {}),
    ...(synth?.affordances.get(stateName) ? { stateAffordance: synth.affordances.get(stateName) } : {}),
    ...(synth?.interaction.get(stateName) ? { interaction: synth.interaction.get(stateName) } : {}),
    capturedAt,
    runId: ctx.runId,
    deterministicFindings: findings,
  };
  ctx.shots.push(shot);
  ctx.onShot?.(shot);
  ctx.progress(
    `shot ${shotId(axes)}${findings.length ? `  (${findings.length} finding${findings.length === 1 ? "" : "s"})` : ""}`,
  );
  return shot;
}

/**
 * Content clipped where nothing scrolls, which the page-scroll check measures
 * and throws away. Runs after it on purpose: when the document DOES scroll
 * sideways that check owns the defect, and this one stays silent rather than
 * filing the same thing twice. Collisions sit under the same switch: both
 * answer "is content where a reader can read it", both are measurements, and
 * a project turning one off is saying it does not want lookout comparing
 * boxes.
 */
async function measureClipping(
  resolved: ResolvedConfig,
  page: Page,
  element: Locator | null,
  elementSelector: string | null,
  axes: ShotAxes,
  ctx: RouteCtx,
  findings: DeterministicFinding[],
): Promise<ScrollerNote[]> {
  if (!ctx.edgeClip) return [];
  try {
    const clip = await checkEdgeClipping(page, element, {
      ignore: resolved.config.checks?.edgeClip?.ignore ?? [],
      elementSelector,
    });
    findings.push(...clip.findings);
    findings.push(...(await checkCollisions(page, element, { elementSelector })));
    return clip.scrollers;
  } catch (e) {
    // A measurement that cannot be taken costs the measurement, never
    // the shot: the same stance the provenance walk takes.
    ctx.progress(`clip check failed on ${shotId(axes)}: ${(e as Error).message.slice(0, 120)}`);
    return [];
  }
}
