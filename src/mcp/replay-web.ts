/**
 * One implementation of every web action, shared by the live tools and by
 * replay. A navigator's click and the click that reproduces it at phone
 * width a minute later, or on next week's run, must be the same code, or
 * the recording would describe something the replay never does.
 *
 * Every action names its control by role and accessible name (the selector
 * the harvest chose is tried first, as the navigation executor does), and
 * every action's outcome is written down: whether the page navigated, and
 * where it stands afterwards. Replay checks the outcome it was promised and
 * refuses to photograph a different screen under the recorded name.
 */
import type { Locator, Page } from "playwright";
import type { StateRecipe } from "../types.js";
import { NavSkip, NavStateError } from "../navigate/execute.js";
import { hoverControl } from "../navigate/indicate.js";
import type { AffordanceRef, RouteHarvest } from "../navigate/store.js";
import { ToolRefusal } from "./driver.js";
import type { Arrival, NavAction } from "./actions.js";

export interface ReplayContext {
  /** The target's origin: an action that leaves it is refused. */
  targetUrl: string;
  /** The URL a route path opens at, with the target's query. */
  urlFor: (path: string) => string;
  exclude: readonly string[];
  allowDestructive: boolean;
}

const MAX_WAIT_MS = 5000;
const SETTLE_MS = 150;

/** The control an action names: the harvest's selector first, role and name as the fallback. */
export async function locateRef(page: Page, ref: AffordanceRef): Promise<Locator | null> {
  if (ref.selector) {
    const bySelector = page.locator(ref.selector).first();
    if (await bySelector.isVisible().catch(() => false)) return bySelector;
  }
  const byRole = page
    .getByRole(ref.role as Parameters<Page["getByRole"]>[0], { name: ref.name, exact: true })
    .first();
  if (await byRole.isVisible().catch(() => false)) return byRole;
  return null;
}

/** An accessible name the config said never to touch. */
export function excludedName(name: string, exclude: readonly string[]): string | null {
  const lower = name.toLowerCase();
  for (const e of exclude) {
    if (!e.startsWith("/") && !/^[.#[]/.test(e) && lower.includes(e.toLowerCase())) return e;
  }
  return null;
}

/** Whether a control submits a form: the structural test for "this mutates data". */
async function submitsForm(target: Locator): Promise<boolean> {
  return target
    .evaluate((el) => {
      const form = el.closest("form");
      if (!form) return false;
      const e = el as HTMLButtonElement | HTMLInputElement;
      const type = (e.getAttribute("type") ?? "").toLowerCase();
      return type === "submit" || (e.tagName === "BUTTON" && type === "");
    })
    .catch(() => false);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function requireOnOrigin(page: Page, ctx: ReplayContext, what: string): Promise<void> {
  const origin = new URL(ctx.targetUrl).origin;
  let now: string;
  try {
    now = new URL(page.url()).origin;
  } catch {
    return;
  }
  if (now === origin) return;
  await page.goBack({ timeout: 10_000 }).catch(() => {});
  throw new ToolRefusal(`${what} left the target's origin (${now}); went back`);
}

async function resolveControl(page: Page, ref: AffordanceRef, ctx: ReplayContext): Promise<Locator> {
  const hit = excludedName(ref.name, ctx.exclude);
  if (hit) throw new ToolRefusal(`"${ref.name}" matches the config's exclude entry ${JSON.stringify(hit)}`);
  const target = await locateRef(page, ref);
  if (!target) throw new NavSkip(`"${ref.name}" (${ref.role}) is not visible on this screen`);
  return target;
}

/**
 * Perform one action on the page and report what it did. Live and replay
 * share this; only the caller differs.
 */
export async function performWeb(page: Page, action: NavAction, ctx: ReplayContext): Promise<NavAction["outcome"]> {
  const before = page.url();
  const a = action.args;
  switch (action.tool) {
    case "open": {
      await page.goto(ctx.urlFor(a.path ?? "/"), { waitUntil: "load", timeout: 45_000 });
      break;
    }
    case "click": {
      if (!a.affordance) throw new ToolRefusal("click names no control");
      const target = await resolveControl(page, a.affordance, ctx);
      if (!ctx.allowDestructive && (await submitsForm(target))) {
        throw new ToolRefusal(`"${a.affordance.name}" submits a form, and this screen was not marked destructive`);
      }
      await target.click({ timeout: MAX_WAIT_MS });
      await page.waitForTimeout(SETTLE_MS);
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
      await requireOnOrigin(page, ctx, `clicking "${a.affordance.name}"`);
      break;
    }
    case "type": {
      if (!a.affordance) throw new ToolRefusal("type names no field");
      const target = await resolveControl(page, a.affordance, ctx);
      await target.fill(a.text ?? "", { timeout: MAX_WAIT_MS });
      break;
    }
    case "press": {
      const key = a.key ?? "";
      if (!key) throw new ToolRefusal("press names no key");
      if (!ctx.allowDestructive && key === "Enter") {
        const inForm = await page.evaluate(() => Boolean(document.activeElement?.closest("form"))).catch(() => false);
        if (inForm) throw new ToolRefusal("Enter would submit the form under focus, and this screen was not marked destructive");
      }
      await page.keyboard.press(key);
      await page.waitForTimeout(SETTLE_MS);
      await requireOnOrigin(page, ctx, `pressing ${key}`);
      break;
    }
    case "hover": {
      if (!a.affordance) throw new ToolRefusal("hover names no control");
      const target = await resolveControl(page, a.affordance, ctx);
      await hoverControl(page, target, a.affordance.name);
      break;
    }
    case "scroll": {
      if (a.affordance) {
        const target = await resolveControl(page, a.affordance, ctx);
        await target.scrollIntoViewIfNeeded({ timeout: MAX_WAIT_MS });
      } else {
        await page.mouse.wheel(0, a.direction === "up" ? -600 : 600);
      }
      await page.waitForTimeout(SETTLE_MS);
      break;
    }
    case "back": {
      await page.goBack({ timeout: 15_000, waitUntil: "load" });
      await requireOnOrigin(page, ctx, "going back");
      break;
    }
    case "wait": {
      await page.waitForTimeout(Math.min(Math.max(0, a.ms ?? 0), MAX_WAIT_MS));
      break;
    }
    default:
      throw new ToolRefusal(`${action.tool} is not a web action`);
  }
  const url = page.url();
  return { url, navigated: pathOf(url) !== pathOf(before) };
}

/**
 * Run a recording again. An action that lands somewhere other than where it
 * was recorded to land is a mislabelling waiting to happen, so it stops the
 * replay rather than photographing the wrong screen under the right name.
 */
export async function replayWeb(page: Page, actions: readonly NavAction[], ctx: ReplayContext): Promise<void> {
  for (const action of actions) {
    const outcome = await performWeb(page, action, ctx);
    if (action.outcome.navigated !== undefined && Boolean(outcome.navigated) !== action.outcome.navigated) {
      throw new NavStateError(
        `${action.tool}${action.args.affordance ? ` "${action.args.affordance.name}"` : ""} ${outcome.navigated ? "navigated" : "did not navigate"}, ` +
          `but the recording says it ${action.outcome.navigated ? "did" : "did not"}`,
      );
    }
    if (action.outcome.navigated && action.outcome.url && outcome.url && pathOf(action.outcome.url) !== pathOf(outcome.url)) {
      throw new NavStateError(`${action.tool} landed on ${pathOf(outcome.url)}, not ${pathOf(action.outcome.url)} as recorded`);
    }
  }
}

/**
 * A recording as a state recipe the route capture can run at every form
 * factor and scheme. No `restore`: the capture reloads the route, which is
 * the one clean-rest guarantee there is. Full page, because what a click
 * opens is as likely to be portaled outside the route's element as inside it.
 */
export function recipeFrom(actions: readonly NavAction[], ctx: ReplayContext, description?: string): StateRecipe {
  const steps = actions.filter((a) => a.tool !== "open");
  return {
    ...(description ? { description } : {}),
    prepare: (page) => replayWeb(page, steps, ctx),
    element: null,
  };
}

/** What the screen looked like on arrival, for a replay to recognise it by. */
export function arrivalOf(harvest: RouteHarvest | null, url: string): Arrival {
  return {
    url,
    ...(harvest ? { signature: harvest.signature } : {}),
    sampleNames: (harvest?.affordances ?? []).slice(0, 12).map((a) => a.name),
  };
}

/**
 * Whether a replay reached the screen it was meant to: the same affordance
 * signature, or at least half of the controls it remembered still there.
 */
export function checkArrival(harvest: RouteHarvest | null, arrival: Arrival | undefined): boolean {
  if (!arrival) return true;
  if (arrival.signature && harvest?.signature === arrival.signature) return true;
  if (arrival.sampleNames.length === 0) return true;
  const names = new Set((harvest?.affordances ?? []).map((a) => a.name));
  const present = arrival.sampleNames.filter((n) => names.has(n)).length;
  return present * 2 >= arrival.sampleNames.length;
}
