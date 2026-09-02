/**
 * How to see it: what a fixer needs to put the same screen in front of
 * themselves that lookout photographed. The URL with the scheme in it, the
 * viewport in CSS pixels and the scale the PNG was taken at, how the colour
 * scheme was applied, the element when only one was framed, what a state
 * other than rest is and how lookout reached it, the design it was judged
 * against, and where the sidecar naming every element on the picture lives.
 *
 * Recorded facts win over derived ones, and a derived one says so: the config
 * can change after a capture, and a fact the document reconstructs from it is
 * "per the current config", never presented as what was photographed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRoutes } from "../targets.js";
import { schemeUrl } from "../capture/web-page.js";
import { routeKey } from "../navigate/store.js";
import { loadSidecarBeside } from "../design/provenance-brief.js";
import { DEFAULT_VIEWPORTS, DEVICE_SCALE_FACTOR, type FormFactor, type Scheme } from "../types.js";
import { shotOf, type IssueContext } from "./context.js";

const DERIVED = "(per the current config)";

function schemeVia(ctx: IssueContext): string {
  const mode = ctx.resolved.config.scheme;
  if (mode?.mode === "url-param") return `the \`${mode.param}\` url parameter, already in the url above`;
  if (mode?.mode === "recipe") return "the config's `setScheme` recipe, run before the screenshot";
  return "emulated `prefers-color-scheme`, the browser's own setting";
}

function stateLine(ctx: IssueContext, target: string, route: string, state: string): string | null {
  if (state === "rest") return null;
  const planned = ctx.plans?.routes[routeKey(target, route)]?.states.find((s) => s.name === state);
  if (planned) {
    const a = planned.affordance;
    return (
      `- state \`${state}\`: ${planned.why}; reached by clicking ${a.role} "${a.name}"` +
      ` (\`${a.selector}\`${a.href ? `, href ${a.href}` : ""}), expecting ${planned.outcome}`
    );
  }
  const recipe = ctx.resolved.config.states?.[state];
  if (recipe?.description) return `- state \`${state}\`: ${recipe.description} (a recipe in the config)`;
  return `- state \`${state}\`: a recipe named in the config; lookout drives the page into it before photographing`;
}

export function howToSeeSection(ctx: IssueContext): string[] {
  const { cluster, resolved, evDir } = ctx;
  if (cluster.channel === "code") return [];
  const target = resolved.config.targets?.find((t) => t.name === cluster.target);
  const routes = target ? resolveRoutes(target, resolved.config.element, resolved.configPath) : [];
  const l: string[] = ["## How to see it", ""];
  const seen = new Set<string>();
  for (const m of cluster.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev) continue;
    const key = `${m.route}|${m.formFactor}|${m.scheme}|${m.state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const shot = shotOf(ctx, ev.shotId);
    const route = routes.find((r) => r.path === m.route);
    const ff = m.formFactor as FormFactor;
    const vp = resolved.config.viewports?.[ff] ?? DEFAULT_VIEWPORTS[ff];

    l.push(`### ${m.route}, ${m.formFactor}, ${m.scheme} scheme, state ${m.state}`, "");
    if (route) l.push(`- url: ${schemeUrl(resolved, route.url, m.scheme as Scheme)} ${DERIVED}`);
    else if (target) l.push(`- url: ${target.url}${m.route === "/" ? "" : m.route} ${DERIVED}; the route is no longer in the config`);
    if (vp) {
      l.push(
        `- viewport: ${vp.width}×${vp.height} css px at ${DEVICE_SCALE_FACTOR}× (the screenshot is ${vp.width * DEVICE_SCALE_FACTOR} px wide) ${DERIVED}`,
      );
    }
    l.push(`- scheme via: ${schemeVia(ctx)}`);
    if (route?.element) l.push(`- element: only \`${route.element}\` was photographed, not the whole page ${DERIVED}`);
    const state = stateLine(ctx, cluster.target, m.route, m.state);
    if (state) l.push(state);
    const design = shot?.design ?? route?.design;
    if (design) {
      l.push(
        `- design hand-off: ${design}${shot?.designHash ? ` (sha256 ${shot.designHash})` : ""}; the judge compared this view to it one to one`,
      );
    }
    const sidecarRel = shot?.provenance ?? `${ev.path}.provenance.json`;
    const sidecarAbs = join(evDir, sidecarRel);
    if (existsSync(sidecarAbs)) {
      const sc = loadSidecarBeside(evDir, ev.path);
      const drift = sc && sc.shotHash !== ev.hash ? "; re-captured since this evidence, so positions may have moved" : "";
      l.push(
        `- provenance sidecar: ${sidecarAbs}` +
          (sc ? ` (${sc.elements.length} elements${sc.truncated ? ", truncated" : ""}, each with its css path, component chain and source hint where the page's dev tooling gave one${drift})` : ""),
      );
    }
    l.push(`- workspace screenshot: ${join(evDir, ev.path)}; overwritten by every capture, so the frozen frame under "Look at these first" is the defect as filed`);
    if (shot) l.push(`- captured ${shot.capturedAt} by run ${shot.runId}`);
    l.push("");
  }
  return l;
}
