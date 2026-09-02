/**
 * How to see it: what a fixer needs to put the same screen in front of
 * themselves that lookout photographed. The URL with the scheme in it, the
 * viewport in CSS pixels and the scale the PNG was taken at, how the colour
 * scheme was applied, the element when only one was framed, what a state
 * other than rest is and how lookout reached it, the design it was judged
 * against, and where the sidecar naming every element on the picture lives.
 *
 * Recorded facts win over derived ones, and a derived one says so: capture
 * writes what it did onto the shot and the finding keeps a copy, so the
 * report in the workspace and the finding itself are both asked before the
 * config is, and a fact reconstructed from the config is "per the current
 * config", never presented as what was photographed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRoutes } from "../targets.js";
import { schemeUrl } from "../capture/web-page.js";
import { routeKey } from "../navigate/store.js";
import { loadSidecarBeside } from "../design/provenance-brief.js";
import { DEFAULT_VIEWPORTS, DEVICE_SCALE_FACTOR, type FormFactor, type Scheme } from "../types.js";
import type { ViewFacts } from "../backlog/lib.js";
import { shotOf, type IssueContext } from "./context.js";

const DERIVED = "(per the current config)";

function schemeVia(mechanism: string | undefined, ctx: IssueContext): string {
  const mode = mechanism ?? ctx.resolved.config.scheme?.mode ?? "emulate";
  if (mode === "url-param") {
    const param = ctx.resolved.config.scheme?.mode === "url-param" ? ctx.resolved.config.scheme.param : undefined;
    return `the ${param ? `\`${param}\` ` : ""}url parameter, already in the url above`;
  }
  if (mode === "recipe") return "the config's `setScheme` recipe, run before the screenshot";
  return "emulated `prefers-color-scheme`, the browser's own setting";
}

function stateLine(ctx: IssueContext, rec: ViewFacts, target: string, route: string, state: string): string | null {
  if (state === "rest") return null;
  // What capture recorded wins: the affordance it clicked, and the planner's
  // own words for the state. Then the plan on disk, then the config's recipe.
  const a = rec.stateAffordance;
  const why = rec.stateDescription;
  if (a) {
    // Not every state is reached by a click. A focus or hover state activates
    // nothing, and telling a fixer to click the control would have them
    // reproduce a different screen from the one the finding is filed against.
    const how =
      rec.interaction === "focus"
        ? "reached by giving keyboard focus to"
        : rec.interaction === "hover"
          ? "reached by resting the pointer on"
          : "reached by clicking";
    return (
      `- state \`${state}\`: ${why ?? "a state lookout drove the page into"}; ${how} ${a.role} "${a.name}"` +
      ` (\`${a.selector}\`${a.href ? `, href ${a.href}` : ""})` +
      (rec.interaction ? "" : a.outcome ? `, expecting ${a.outcome}` : "")
    );
  }
  const planned = ctx.plans?.routes[routeKey(target, route)]?.states.find((s) => s.name === state);
  if (planned) {
    const p = planned.affordance;
    return (
      `- state \`${state}\`: ${planned.why}; reached by clicking ${p.role} "${p.name}"` +
      ` (\`${p.selector}\`${p.href ? `, href ${p.href}` : ""}), expecting ${planned.outcome}`
    );
  }
  if (why) return `- state \`${state}\`: ${why}`;
  const recipe = ctx.resolved.config.states?.[state];
  if (recipe?.description) return `- state \`${state}\`: ${recipe.description} (a recipe in the config)`;
  return `- state \`${state}\`: a recipe named in the config; lookout drives the page into it before photographing`;
}

/**
 * How a device view is reached: the deep link with the scheme in it, the
 * device it was opened on, and the commands lookout used, per platform.
 */
function deviceLines(ctx: IssueContext, platform: string, rec: ViewFacts, route: string, scheme: Scheme): string[] {
  const app = platform === "ios" || platform === "android" ? ctx.resolved.config.native?.[platform] : undefined;
  const l: string[] = [];
  if (rec.url) l.push(`- deep link: ${rec.url}`);
  else if (app) {
    const url = new URL(`${app.deepLinkScheme}:///${route.replace(/^\//, "")}`);
    if (app.appearanceParam) url.searchParams.set(app.appearanceParam, scheme);
    l.push(`- deep link: ${url.toString()} ${DERIVED}`);
  }
  if (rec.device) l.push(`- device: ${rec.device.name} (${platform}, id ${rec.device.id})`);
  else l.push(`- device: whichever ${platform} simulator or emulator of this kind is booted; lookout addresses it by its own id`);
  l.push(
    app?.appearanceParam
      ? `- scheme via: the \`${app.appearanceParam}\` query parameter on the deep link, which the app reads`
      : `- scheme via: the device's own appearance; the app names no appearanceParam, so only what the device shows is captured`,
  );
  l.push(
    platform === "ios"
      ? `- how lookout opened it: \`xcrun simctl terminate <id> ${app?.bundleId ?? "<bundleId>"}\`, then \`xcrun simctl openurl <id> <deep link>\`, waited, and took \`xcrun simctl io <id> screenshot\``
      : `- how lookout opened it: \`adb -s <id> shell am force-stop ${app?.bundleId ?? "<bundleId>"}\`, then \`adb -s <id> shell am start -a android.intent.action.VIEW -d <deep link>\`, waited, and took \`adb -s <id> exec-out screencap -p\``,
  );
  return l;
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
    // What the finding kept of the view, under whatever the workspace still
    // records about the shot: two sources of the same facts, the fresher one
    // winning field by field rather than the whole record at once.
    const rec: ViewFacts = { ...(m.view ?? {}), ...(shot ?? {}) };
    const route = routes.find((r) => r.path === m.route);
    const ff = m.formFactor as FormFactor;
    const vp = rec.viewport ?? resolved.config.viewports?.[ff] ?? DEFAULT_VIEWPORTS[ff];
    const dpr = rec.dpr ?? DEVICE_SCALE_FACTOR;
    const platform = m.platform ?? shot?.platform ?? "web";

    if (platform !== "web") {
      // A device view: the deep link lookout opened, on which simulator or
      // emulator, and how, so a fixer can put the same screen in front of
      // themselves. There is no viewport to state; the device is the viewport.
      l.push(`### ${m.route} on ${platform}, ${m.formFactor}, ${m.scheme} scheme, state ${m.state}`, "");
      l.push(...deviceLines(ctx, platform, rec, m.route, m.scheme as Scheme));
    } else {
      l.push(`### ${m.route}, ${m.formFactor}, ${m.scheme} scheme, state ${m.state}`, "");
      if (rec.url) l.push(`- url: ${rec.url}${rec.finalUrl && rec.finalUrl !== rec.url ? `, which landed on ${rec.finalUrl}` : ""}`);
      else if (route) l.push(`- url: ${schemeUrl(resolved, route.url, m.scheme as Scheme)} ${DERIVED}`);
      else if (target) l.push(`- url: ${target.url}${m.route === "/" ? "" : m.route} ${DERIVED}; the route is no longer in the config`);
      if (vp) {
        l.push(
          `- viewport: ${vp.width}×${vp.height} css px at ${dpr}× (the screenshot is ${vp.width * dpr} px wide)${rec.viewport ? "" : ` ${DERIVED}`}`,
        );
      }
      l.push(`- scheme via: ${schemeVia(rec.schemeMechanism, ctx)}`);
    }
    const element = rec.element ?? route?.element;
    if (element) l.push(`- element: only \`${element}\` was photographed, not the whole page${rec.element ? "" : ` ${DERIVED}`}`);
    const state = stateLine(ctx, rec, cluster.target, m.route, m.state);
    if (state) l.push(state);
    const design = rec.design ?? route?.design;
    if (design) {
      l.push(`- design hand-off: ${design}${rec.designHash ? ` (sha256 ${rec.designHash})` : ""}; the judge compared this view to it one to one`);
    }
    const sidecarRel = rec.provenance ?? `${ev.path}.provenance.json`;
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
