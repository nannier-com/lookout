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

/** A thrown error's stack, as much of it as names files without becoming a transcript. */
const MAX_STACK_FRAMES = 12;
const MAX_STACK_CHARS = 2000;

export interface ConsoleCollector {
  drain(): DeterministicFinding[];
  dispose(): void;
}

export function attachConsoleCollector(page: Page): ConsoleCollector {
  const pending: DeterministicFinding[] = [];
  const seen = new Set<string>();
  // The first sighting of each console error, so a repeat can be counted on
  // it rather than filed again: how often it fires is a fact, the text twice
  // is not.
  const firstOf = new Map<string, DeterministicFinding>();

  const onConsole = (msg: {
    type(): string;
    text(): string;
    location(): { url: string; lineNumber: number; columnNumber?: number };
  }) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (CONSOLE_ALLOWLIST.some((re) => re.test(text))) return;
    if (seen.has(text)) {
      const first = firstOf.get(text);
      if (first?.meta) first.meta.repeats = Number(first.meta.repeats ?? 1) + 1;
      return;
    }
    seen.add(text);
    const loc = msg.location();
    const finding: DeterministicFinding = {
      type: "console-error",
      severity: "error",
      message: text.slice(0, 500),
      meta: { url: loc.url, line: loc.lineNumber, ...(loc.columnNumber !== undefined ? { column: loc.columnNumber } : {}), repeats: 1 },
    };
    firstOf.set(text, finding);
    pending.push(finding);
  };
  const onPageError = (err: Error) => {
    const head = String(err.message ?? err).slice(0, 500);
    if (seen.has(head)) return;
    seen.add(head);
    // The stack names the file and line that threw: the one thing a fixer
    // needs from an uncaught error, and it used to be dropped here.
    const stack = typeof err.stack === "string" ? err.stack.split("\n").slice(0, MAX_STACK_FRAMES).join("\n").slice(0, MAX_STACK_CHARS) : undefined;
    pending.push({ type: "page-error", severity: "error", message: head, ...(stack ? { meta: { stack } } : {}) });
  };
  const onRequestFailed = (req: {
    url(): string;
    method?(): string;
    resourceType?(): string;
    failure(): { errorText: string } | null;
  }) => {
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
      meta: {
        url: req.url().slice(0, 500),
        errorText: failure.errorText,
        ...(req.method ? { method: req.method() } : {}),
        ...(req.resourceType ? { resourceType: req.resourceType() } : {}),
      },
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
      // Every protruder, worst first: the single worst names the finding, the
      // rest are what a fixer reads when the first one is a symptom.
      const candidates: { delta: number; el: Element }[] = [];
      const walk = (el: Element) => {
        const delta = el.scrollWidth - el.clientWidth;
        // Ignore intentional horizontal scrollers.
        const overflowX = getComputedStyle(el).overflowX;
        if (delta > 0 && overflowX !== "auto" && overflowX !== "scroll") candidates.push({ delta, el });
        for (const child of el.children) walk(child);
      };
      walk(root);
      candidates.sort((a, b) => b.delta - a.delta);
      // The offender's real selector, so provenance can name the element the
      // label only describes. The nth-of-type builder is deliberately
      // duplicated from navigate/harvest.ts collectInPage: in-page functions
      // are self-contained by rule and cannot share an import.
      const pathOf = (start: Element): string => {
        const segs: string[] = [];
        let cur: Element | null = start;
        while (cur && cur !== document.body && segs.length < 8) {
          if (cur.id) {
            segs.unshift(`#${cur.id}`);
            break;
          }
          const parent: Element | null = cur.parentElement;
          let nth = 1;
          if (parent) {
            for (const sib of Array.from(parent.children)) {
              if (sib === cur) break;
              if (sib.tagName === cur.tagName) nth += 1;
            }
          }
          segs.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nth})`);
          cur = parent;
        }
        return segs.join(" > ");
      };
      const label = (el: Element): string =>
        `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/)[0] : ""}`;
      const top = candidates[0];
      return {
        worst: top?.delta ?? 0,
        offender: top ? label(top.el) : "",
        offenderPath: top ? pathOf(top.el) : "",
        offenders: candidates.slice(0, 5).map((c) => ({ path: pathOf(c.el), delta: c.delta, tag: label(c.el) })),
      };
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
    // The widest protruder: the element whose right edge reaches furthest
    // past the viewport, intentional scrollers excluded. The full-page branch
    // named no offender at all, which left the provenance join nothing to
    // bite on for the common overflow case.
    const candidates: { right: number; el: Element }[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") continue;
      const right = el.getBoundingClientRect().right + window.scrollX;
      if (right > doc.clientWidth) candidates.push({ right, el });
    }
    candidates.sort((a, b) => b.right - a.right);
    const pathOf = (start: Element): string => {
      const segs: string[] = [];
      let cur: Element | null = start;
      while (cur && cur !== document.body && segs.length < 8) {
        if (cur.id) {
          segs.unshift(`#${cur.id}`);
          break;
        }
        const parent: Element | null = cur.parentElement;
        let nth = 1;
        if (parent) {
          for (const sib of Array.from(parent.children)) {
            if (sib === cur) break;
            if (sib.tagName === cur.tagName) nth += 1;
          }
        }
        segs.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nth})`);
        cur = parent;
      }
      return segs.join(" > ");
    };
    const top = candidates[0];
    return {
      delta,
      viewport: doc.clientWidth,
      offenderPath: top ? pathOf(top.el) : "",
      // The widest five, each with how far past the viewport its right edge sits.
      offenders: candidates.slice(0, 5).map((c) => ({ path: pathOf(c.el), delta: Math.round(c.right - doc.clientWidth), tag: c.el.tagName.toLowerCase() })),
    };
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
