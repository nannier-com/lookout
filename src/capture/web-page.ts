/**
 * Page-level helpers the web capture engine drives: scheme plumbing, settling,
 * element resolution, and the scheme read-back. Split from web.ts so the
 * engine file holds only the walk itself.
 */
import type { Locator, Page } from "playwright";
import type { ResolvedConfig, Scheme, ShotRecord } from "../types.js";

export function schemeUrl(resolved: ResolvedConfig, routeUrl: string, scheme: Scheme): string {
  const mode = resolved.config.scheme;
  if (mode?.mode !== "url-param") return routeUrl;
  const u = new URL(routeUrl);
  u.searchParams.set(mode.param, scheme);
  return u.toString();
}

export async function setScheme(resolved: ResolvedConfig, page: Page, scheme: Scheme): Promise<void> {
  const mode = resolved.config.scheme ?? { mode: "emulate" as const };
  if (mode.mode === "emulate") {
    await page.emulateMedia({ colorScheme: scheme });
  } else if (mode.mode === "recipe") {
    await resolved.config.setScheme!(page, scheme);
  }
  // url-param is handled in the navigation URL.
}

export async function settle(page: Page, settleMs: number): Promise<void> {
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

export async function resolveElement(page: Page, selector: string | undefined): Promise<Locator | null> {
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
export function markSchemeMismatches(shots: ShotRecord[]): void {
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
          "(configure scheme: url-param or a setScheme recipe in lookout.config.ts)",
      });
    }
  }
}

/**
 * Indicator read-back: a focus or hover shot whose pixels are identical to its
 * own rest shot means the interaction changed nothing on screen.
 *
 * This is the half of a focus or hover state a judge cannot rule on. A
 * screenshot never draws the cursor, and a judge sees a state's view group
 * without its rest sibling, so "hovering this did nothing" is not visible in
 * the evidence it is given: it is a comparison, and comparisons are what the
 * deterministic channel is for. The same read-back the scheme check does.
 *
 * One-sided on purpose. Identical pixels prove the interaction did nothing;
 * different pixels prove only that SOMETHING moved, which a clock or a lazy
 * image can do on its own, so nothing is filed in that direction.
 */
export function markIndicatorReadback(shots: ShotRecord[]): void {
  const rest = new Map<string, ShotRecord>();
  for (const s of shots) {
    if (s.state === "rest") {
      rest.set([s.platform, s.target, s.route, s.formFactor, s.scheme].join("|"), s);
    }
  }
  for (const s of shots) {
    if (!s.interaction) continue;
    const twin = rest.get([s.platform, s.target, s.route, s.formFactor, s.scheme].join("|"));
    if (!twin || twin.hash !== s.hash) continue;
    const name = s.stateAffordance?.name ?? "the control";
    s.deterministicFindings.push(
      s.interaction === "focus"
        ? {
            type: "focus-invisible",
            severity: "warning",
            message:
              `"${name}" has keyboard focus in this shot and the screen is unchanged from at rest, ` +
              "so nothing marks where a keyboard user is",
            meta: { control: name, restShotId: twin.id },
          }
        : {
            type: "hover-silent",
            severity: "warning",
            message:
              `the pointer is on "${name}" in this shot and the screen is unchanged from at rest, ` +
              "so hovering it gives no sign it can be used",
            meta: { control: name, restShotId: twin.id },
          },
    );
  }
}
