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
