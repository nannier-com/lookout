/**
 * Content clipped where nothing scrolls: the defect the judges could see and
 * were forbidden to measure.
 *
 * `checkHorizontalOverflow` files only when the DOCUMENT scrolls sideways. An
 * element pushed past the viewport by a header with `overflow: hidden`, or past
 * the padding edge of any clipping ancestor, produces no page scroll at all, so
 * that check computes the offenders and throws them away. What was left to
 * notice it was a judge reading an image, which the rubric rightly tells it
 * cannot measure, so the finding arrived (when it arrived) as an eye-judged
 * claim under whichever category the panel that happened to run owned, and the
 * adversarial verifier could refute it by calling the missing content a
 * deliberate responsive collapse. A box is not arguable.
 *
 * The opposite mistake is the reason for every exclusion below. Content inside
 * a horizontal scroller is reachable, a truncated label with an ellipsis is
 * deliberate, a collapsed menu is not rendered, and a visually-hidden helper is
 * meant to be invisible. Each of those protrudes past something on purpose, and
 * filing them would bury the real clip in noise.
 *
 * Split the way harvest and provenance are: one self-contained `page.evaluate`
 * collects raw facts, and everything that decides is pure and unit-tested with
 * no browser.
 */
import type { Locator, Page } from "playwright";
import type { DeterministicFinding } from "../types.js";

/** Protrusion under this many CSS px is rounding, not a clip. */
const SLACK = 2;
/** Named in the finding; the rest are counted. Mirrors horizontal-overflow. */
const MAX_OFFENDERS = 5;
/** The same ceiling the provenance walk uses, for the same reason. */
const MAX_ELEMENTS = 800;

/** What kind of thing did the clipping: decides the attribute, so it is closed. */
export type ClipperKind = "viewport" | "ancestor";

/** One element measured against the thing that clips it. Raw: nothing decided. */
export interface ClipCandidate {
  /** nth-of-type path, the same shape every other in-page walk produces. */
  path: string;
  tag: string;
  /** Trimmed innerText, for a finding a person can locate on the screen. */
  text: string;
  clipper: ClipperKind;
  /** The clipper's own path, empty for the viewport. */
  clipperPath: string;
  /** CSS px past the clipper's right padding edge; 0 or less is inside. */
  overRight: number;
  /** CSS px past the clipper's bottom padding edge. */
  overBottom: number;
  /** An ancestor between the two scrolls horizontally, so this is reachable. */
  scrollable: boolean;
  /** Deliberate truncation, hiding, or a transform the box cannot be read through. */
  excused: boolean;
}

/** A horizontal scroller and how much of it is off screen, for the manifest note. */
export interface ScrollerNote {
  path: string;
  tag: string;
  width: number;
  hiddenWidth: number;
}

export interface ClipHarvest {
  candidates: ClipCandidate[];
  scrollers: ScrollerNote[];
  /** The walk hit its ceiling; an absence claim is not available from it. */
  truncated: boolean;
}

/**
 * Runs in the browser. Self-contained: no closure over module scope, the same
 * rule harvest.ts and provenance.ts follow, which is why the path builder is
 * duplicated here rather than imported.
 */
export function collectClipsInPage(args: {
  rootSelector: string | null;
  ignore: string[];
  maxElements: number;
  slack: number;
}): ClipHarvest {
  const doc = document.documentElement;
  const root: Element =
    (args.rootSelector ? document.querySelector(args.rootSelector) : null) ?? doc;

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

  // Ignored subtrees, resolved once. A project names what it knows renders
  // outside its box on purpose (a carousel track, a marquee).
  const ignored: Element[] = [];
  for (const sel of args.ignore) {
    try {
      for (const el of Array.from(document.querySelectorAll(sel))) ignored.push(el);
    } catch {
      // an unparseable selector ignores nothing, silently: a config typo must
      // not cost the capture
    }
  }

  const INTERACTIVE = ["button", "a", "input", "select", "textarea", "summary"];
  const INTERACTIVE_ROLES = ["button", "link", "tab", "menuitem", "checkbox", "switch"];
  const styleOf = new Map<Element, CSSStyleDeclaration>();
  const css = (el: Element): CSSStyleDeclaration => {
    let s = styleOf.get(el);
    if (!s) {
      s = window.getComputedStyle(el);
      styleOf.set(el, s);
    }
    return s;
  };
  const clipsAxis = (v: string): boolean => v === "hidden" || v === "clip";
  const scrollsAxis = (v: string): boolean => v === "auto" || v === "scroll";

  const scrollers: ScrollerNote[] = [];
  const seenScroller = new Set<Element>();
  const candidates: ClipCandidate[] = [];
  const all: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
  let truncated = false;
  let looked = 0;

  for (const el of all) {
    if (looked >= args.maxElements) {
      truncated = true;
      break;
    }
    const he = el as HTMLElement;
    const style = css(el);
    if (style.display === "none" || style.visibility === "hidden") continue;

    // Every horizontal scroller in the frame, whether or not anything is
    // clipped: this is what tells a judge that content it cannot see is
    // reachable rather than lost.
    if (scrollsAxis(style.overflowX) && el.scrollWidth - el.clientWidth > args.slack && !seenScroller.has(el)) {
      seenScroller.add(el);
      scrollers.push({
        path: pathOf(el),
        tag: el.tagName.toLowerCase(),
        width: Math.round(el.clientWidth),
        hiddenWidth: Math.round(el.scrollWidth - el.clientWidth),
      });
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const ownText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
    );
    const interesting =
      ownText ||
      tag === "img" ||
      INTERACTIVE.includes(tag) ||
      (role !== null && INTERACTIVE_ROLES.includes(role));
    if (!interesting) continue;
    looked += 1;
    if (ignored.some((ig) => ig === el || ig.contains(el))) continue;

    const rect = he.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    // Walk up for the nearest thing that clips, noting a scroll path on the
    // way. The viewport is the clipper of last resort, and only when the
    // document itself does not scroll: when it does, the page-scroll check
    // already owns the defect and restating it would file it twice.
    let clipper: ClipperKind | null = null;
    let clipperPath = "";
    let clipRect: DOMRect | null = null;
    let padRight = 0;
    let padBottom = 0;
    let scrollable = false;
    let transformed = false;
    let hiddenByState = false;
    for (let cur: Element | null = el.parentElement; cur; cur = cur.parentElement) {
      const cs = css(cur);
      if (cs.transform !== "none" || cs.clipPath !== "none") transformed = true;
      if (cur.getAttribute("aria-expanded") === "false" || cur.getAttribute("aria-hidden") === "true") {
        hiddenByState = true;
      }
      if (scrollsAxis(cs.overflowX) || scrollsAxis(cs.overflowY)) scrollable = true;
      if (clipsAxis(cs.overflowX) || clipsAxis(cs.overflowY)) {
        clipper = "ancestor";
        clipperPath = pathOf(cur);
        clipRect = cur.getBoundingClientRect();
        padRight = parseFloat(cs.paddingRight) || 0;
        padBottom = parseFloat(cs.paddingBottom) || 0;
        break;
      }
    }
    if (!clipper) {
      if (doc.scrollWidth - doc.clientWidth > args.slack) continue;
      clipper = "viewport";
      clipRect = new DOMRect(0, 0, doc.clientWidth, doc.clientHeight);
    }

    const right = clipRect!.right - padRight;
    const bottom = clipper === "viewport" ? Number.POSITIVE_INFINITY : clipRect!.bottom - padBottom;
    const overRight = rect.right - right;
    const overBottom = bottom === Number.POSITIVE_INFINITY ? 0 : rect.bottom - bottom;
    if (overRight <= args.slack && overBottom <= args.slack) continue;

    // Deliberate: a label that truncates with an ellipsis or a line clamp says
    // so in its own style, a helper meant for screen readers is a 1px box, and
    // a box read through a transform or a clip-path is not a box lookout can
    // measure honestly.
    const clamped = (style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp;
    const excused =
      (style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap") ||
      (clamped !== undefined && clamped !== "" && clamped !== "none") ||
      style.opacity === "0" ||
      el.getAttribute("aria-hidden") === "true" ||
      he.hidden ||
      (rect.width <= 1 && rect.height <= 1) ||
      transformed ||
      hiddenByState;

    candidates.push({
      path: pathOf(el),
      tag,
      text: (he.innerText || he.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60),
      clipper,
      clipperPath,
      overRight: Math.round(Math.max(0, overRight)),
      overBottom: Math.round(Math.max(0, overBottom)),
      scrollable,
      excused,
    });
  }

  return { candidates, scrollers, truncated };
}

/**
 * Which candidates are defects, as at most one finding per clipper kind.
 *
 * Pure, so the whole decision is testable without a browser: the in-page half
 * measures, this half rules. One finding per kind rather than per element,
 * mirroring horizontal-overflow, because a header that clips has usually
 * clipped several things at once and they are one fix.
 */
export function classifyClips(harvest: ClipHarvest): DeterministicFinding[] {
  const real = harvest.candidates.filter((c) => !c.excused && !c.scrollable);
  const findings: DeterministicFinding[] = [];
  for (const kind of ["viewport", "ancestor"] as ClipperKind[]) {
    const hits = real
      .filter((c) => c.clipper === kind)
      .sort((a, b) => Math.max(b.overRight, b.overBottom) - Math.max(a.overRight, a.overBottom));
    const worst = hits[0];
    if (!worst) continue;
    const over = Math.max(worst.overRight, worst.overBottom);
    const where = worst.overRight >= worst.overBottom ? "past the right edge" : "below the bottom edge";
    // The element's own words where it has any, its tag where it does not.
    // This opens a sentence somebody reads, so the fallback is capitalised.
    const named = worst.text ? `"${worst.text}"` : `A ${worst.tag}`;
    findings.push({
      type: "edge-clipped",
      severity: "error",
      message:
        kind === "viewport"
          ? `${named} extends ${over}px ${where} of the viewport and the page does not scroll to reach it` +
            (hits.length > 1 ? ` (${hits.length} elements clipped)` : "")
          : `${named} extends ${over}px ${where} of an ancestor that hides its overflow` +
            (hits.length > 1 ? ` (${hits.length} elements clipped)` : ""),
      meta: {
        clipper: kind,
        offenderPath: worst.path,
        offenders: hits.slice(0, MAX_OFFENDERS).map((c) => ({
          path: c.path,
          tag: c.tag,
          text: c.text,
          overRight: c.overRight,
          overBottom: c.overBottom,
          clipperPath: c.clipperPath,
        })),
        clipped: hits.length,
      },
    });
  }
  return findings;
}

/** Measure this shot, and rule. Returns the findings and the scrollers to note. */
export async function checkEdgeClipping(
  page: Page,
  element: Locator | null,
  opts: { ignore?: string[]; elementSelector?: string | null } = {},
): Promise<{ findings: DeterministicFinding[]; scrollers: ScrollerNote[] }> {
  const harvest = await page.evaluate(collectClipsInPage, {
    rootSelector: element ? opts.elementSelector ?? null : null,
    ignore: opts.ignore ?? [],
    maxElements: MAX_ELEMENTS,
    slack: SLACK,
  });
  return { findings: classifyClips(harvest), scrollers: harvest.scrollers.slice(0, 5) };
}
