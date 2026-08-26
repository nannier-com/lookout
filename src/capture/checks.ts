/**
 * Deterministic checks that ride along with capture. Every check returns
 * findings (empty = pass) and never throws for a finding; only infrastructure
 * failures throw.
 */
import type { Locator, Page } from "playwright";
import type { DeterministicFinding } from "../types.js";

// ---------------------------------------------------------------------------
// Console / page errors. Attach once per page; drain after each shot so the
// finding lands on the shot that surfaced it. Deduped per page by text.
// ---------------------------------------------------------------------------

/** Noise the web platform emits that is not the app's fault. */
const CONSOLE_ALLOWLIST: RegExp[] = [
  /Download the React DevTools/i,
  /\[fast refresh\]/i,
  /React DevTools/i,
  /source map/i,
];

export interface ConsoleCollector {
  drain(): DeterministicFinding[];
  dispose(): void;
}

export function attachConsoleCollector(page: Page): ConsoleCollector {
  const pending: DeterministicFinding[] = [];
  const seen = new Set<string>();

  const onConsole = (msg: { type(): string; text(): string; location(): { url: string; lineNumber: number } }) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (CONSOLE_ALLOWLIST.some((re) => re.test(text))) return;
    if (seen.has(text)) return;
    seen.add(text);
    const loc = msg.location();
    pending.push({
      type: "console-error",
      severity: "error",
      message: text.slice(0, 500),
      meta: { url: loc.url, line: loc.lineNumber },
    });
  };
  const onPageError = (err: Error) => {
    const head = String(err.message ?? err).slice(0, 500);
    if (seen.has(head)) return;
    seen.add(head);
    pending.push({ type: "page-error", severity: "error", message: head });
  };
  const onRequestFailed = (req: { url(): string; failure(): { errorText: string } | null }) => {
    // Aborted requests are routine (navigation, HMR); only surface hard failures.
    const failure = req.failure();
    if (!failure || /aborted|cancelled/i.test(failure.errorText)) return;
    const key = `${failure.errorText} ${req.url()}`;
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({
      type: "request-failed",
      severity: "warning",
      message: `${failure.errorText}: ${req.url().slice(0, 300)}`,
    });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);

  return {
    drain() {
      return pending.splice(0, pending.length);
    },
    dispose() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
    },
  };
}

// ---------------------------------------------------------------------------
// Horizontal overflow: content wider than its scroll container is the classic
// responsive failure. Full-page: the document must not scroll sideways.
// Element: no descendant may protrude.
// ---------------------------------------------------------------------------

export async function checkHorizontalOverflow(
  page: Page,
  element: Locator | null,
): Promise<DeterministicFinding[]> {
  if (element) {
    const res = await element.evaluate((root) => {
      let worst = 0;
      let offender = "";
      const walk = (el: Element) => {
        const delta = el.scrollWidth - el.clientWidth;
        // Ignore intentional horizontal scrollers.
        const overflowX = getComputedStyle(el).overflowX;
        if (delta > worst && overflowX !== "auto" && overflowX !== "scroll") {
          worst = delta;
          offender = `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/)[0] : ""}`;
        }
        for (const child of el.children) walk(child);
      };
      walk(root);
      return { worst, offender };
    });
    if (res.worst > 2) {
      return [
        {
          type: "horizontal-overflow",
          severity: "error",
          message: `content protrudes ${res.worst}px horizontally (${res.offender})`,
          meta: res,
        },
      ];
    }
    return [];
  }

  const res = await page.evaluate(() => {
    const doc = document.documentElement;
    const delta = doc.scrollWidth - doc.clientWidth;
    return { delta, viewport: doc.clientWidth };
  });
  if (res.delta > 2) {
    return [
      {
        type: "horizontal-overflow",
        severity: "error",
        message: `page scrolls ${res.delta}px sideways at ${res.viewport}px viewport`,
        meta: res,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// axe accessibility scan. Scoped to the element when one is given. The
// color-contrast rule is off by default: computed-style contrast over
// translucent/washed surfaces false-positives heavily; the AI judge sees real
// pixels instead. --axe-contrast turns it on.
// ---------------------------------------------------------------------------

export async function runAxe(
  page: Page,
  includeSelector: string | null,
  opts: { contrast: boolean },
): Promise<DeterministicFinding[]> {
  const { AxeBuilder } = await import("@axe-core/playwright");
  let builder = new AxeBuilder({ page });
  if (includeSelector) builder = builder.include(includeSelector);
  if (!opts.contrast) builder = builder.disableRules(["color-contrast"]);
  const result = await builder.analyze();
  return result.violations.map((v) => ({
    type: "axe-violation" as const,
    severity: v.impact === "critical" || v.impact === "serious" ? ("error" as const) : ("warning" as const),
    message: `${v.id}: ${v.help}`,
    meta: {
      ruleId: v.id,
      impact: v.impact,
      nodeCount: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
      helpUrl: v.helpUrl,
    },
  }));
}

// ---------------------------------------------------------------------------
// Blank-shot guard: a near-uniform image means the app had not painted (font
// gates, splash screens). Byte thresholds do not transfer across sizes; pixel
// standard deviation does.
// ---------------------------------------------------------------------------

export async function blankShotGuard(png: Buffer | Uint8Array): Promise<DeterministicFinding[]> {
  const sharp = (await import("sharp")).default;
  const stats = await sharp(png).stats();
  const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
  if (maxStdev < 1) {
    return [
      {
        type: "blank-shot",
        severity: "error",
        message: `image is near-uniform (max channel stdev ${maxStdev.toFixed(2)}); the app likely had not painted`,
      },
    ];
  }
  return [];
}

/**
 * The page must still be on the target it was pointed at. An app that bounces
 * to a different origin (a login host, an SSO provider, a marketing site) will
 * otherwise be photographed and filed under the route that was requested, so
 * every finding on that shot describes the wrong application.
 *
 * Same-origin redirects are fine and stay silent: only a different origin is
 * reported, because that is the one the route label can no longer describe.
 */
export function checkOffOrigin(finalUrl: string, targetUrl: string): DeterministicFinding[] {
  let landed: URL;
  let expected: URL;
  try {
    landed = new URL(finalUrl);
    expected = new URL(targetUrl);
  } catch {
    return [];
  }
  if (landed.origin === expected.origin) return [];
  return [
    {
      type: "off-origin",
      severity: "error",
      message:
        `capture landed on ${landed.origin}, not the target's ${expected.origin}; ` +
        `this shot shows a different app, so its route label and any finding on it are misattributed ` +
        `(sign the target in with a signIn hook, or capture that origin as its own target)`,
      meta: { landed: landed.origin, expected: expected.origin, finalUrl: landed.href },
    },
  ];
}

/** Two samples 400ms apart differing means animation; hash caching is then unreliable. */
export async function detectAnimated(
  page: Page,
  element: Locator | null,
): Promise<boolean> {
  const take = async () =>
    element ? element.screenshot({ animations: "allow" }) : page.screenshot({ animations: "allow" });
  const a = await take();
  await page.waitForTimeout(400);
  const b = await take();
  return !a.equals(b);
}
