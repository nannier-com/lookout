/**
 * The two states that are about the pointer and the keyboard rather than about
 * what a click opens: a control under focus, and a control under the pointer.
 *
 * This is a deliberate narrowing of a rule the rubric was right to have. Focus
 * rings were never filed because nothing in a rest, overlay or in-page shot
 * holds focus on purpose, so a ring there is an accident of whatever was last
 * clicked, and a still image cannot show focus ORDER at all. Both stay true.
 * What changes is that lookout can now drive ONE named control into focus on
 * purpose and say on the manifest line which one, and that control's indicator
 * on that one shot is then evidence rather than an accident.
 *
 * Two facts about the browser shape the actuation:
 *
 * - Chromium paints a `:focus-visible` ring only in keyboard modality, so
 *   `focus()` alone on a document that has been clicked shows nothing. The
 *   recipe presses Tab first and then verifies the ring is actually on. A
 *   control that will not show one is a skip, not a shot: photographing it
 *   would file "no focus indicator" against the capture rather than the app.
 * - Screenshots never draw the cursor. A hover shot shows what hovering DID,
 *   never where the pointer is, so nothing about it tells a judge which control
 *   was hovered except the manifest line that names it.
 */
import type { Locator, Page } from "playwright";
import { NavSkip } from "./execute.js";

/** The interaction a state was captured under, when it was captured under one. */
export type Interaction = "focus" | "hover";

/** At most one focus state per route, and one hover state. */
export const DEFAULT_MAX_FOCUS = 1;
export const DEFAULT_MAX_HOVER = 1;

/** A hover state's settle: CSS transitions are fast-forwarded, JS tooltips are not. */
const HOVER_SETTLE_MS = 400;

/** The prefix a planned indicator state's name carries, so the axis reads as itself. */
export const PREFIX: Record<Interaction, string> = { focus: "focus-", hover: "hover-" };

/** State names are capped at 40 characters; a prefix that will not fit is dropped. */
const MAX_NAME = 40;

/**
 * The planner's name with its interaction spelled out, where that still fits.
 * The prefix is a convenience for whoever reads a shot id, never identity: the
 * record's `interaction` field is what anything downstream reads.
 */
export function prefixed(name: string, interaction: Interaction): string {
  const p = PREFIX[interaction];
  if (name.startsWith(p)) return name;
  const withPrefix = `${p}${name}`;
  return withPrefix.length <= MAX_NAME ? withPrefix : name;
}

/**
 * Hovering is not an interaction a phone has.
 *
 * Takes any outcome, not just an indicator one, so the capture walk can ask it
 * about every planned state without narrowing first. This is the one copy of
 * the rule: execute.ts applies it, and a test that pins it pins what capture
 * actually obeys.
 */
export function skipsAt(outcome: string, formFactor: string): boolean {
  return outcome === "hover" && formFactor === "phone";
}

/**
 * Put the keyboard on this control and prove the browser shows it.
 *
 * The Tab press is what puts Chromium in keyboard modality; the `focus()` that
 * follows is what lands on the control the plan actually named, since one Tab
 * from wherever the document starts lands somewhere arbitrary.
 */
export async function focusControl(page: Page, target: Locator, name: string): Promise<void> {
  await page.keyboard.press("Tab");
  await target.focus({ timeout: 5_000 });
  const shown = await target.evaluate(
    (el) => el === document.activeElement && el.matches(":focus-visible"),
  );
  if (!shown) {
    // A skip, not an error. The shot would say nothing about the application's
    // focus indicator, and filing a capture-error for it would put lookout's
    // own limitation in the project's backlog once per form factor and scheme,
    // on every run. (A control that cannot take keyboard focus at all is a real
    // accessibility defect, and one this does not catch; that belongs to the
    // accessibility scan, not to a state recipe.)
    throw new NavSkip(
      `focus landed on "${name}" and the browser did not show it as keyboard focus, so this ` +
        "shot would say nothing about the application's focus indicator",
    );
  }
}

/** Put the pointer on this control and let whatever it triggers settle. */
export async function hoverControl(page: Page, target: Locator, name: string): Promise<void> {
  await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {
    throw new NavSkip(`"${name}" could not be scrolled into view at this form factor`);
  });
  await target.hover({ timeout: 5_000 });
  // Captures disable animation, so a CSS transition is already at its end
  // state; a tooltip on a JS delay is not, and this is that delay.
  await page.waitForTimeout(HOVER_SETTLE_MS);
}
