/**
 * Content painted over other content: the overlap nothing measures.
 *
 * Every geometry check here asks the same question about one element and its
 * container. None of them compares two elements with each other, so a chip
 * drawn across the name beside it, a floating button covering the last row of a
 * table, or a sticky bar sitting on the heading under it, all of which destroy
 * information outright, are visible to nobody but a judge reading an image.
 *
 * Overlap on its own means nothing: a page is layers, and most of them are
 * meant to be. The whole difficulty is separating a collision from the many
 * legitimate reasons two boxes intersect, which is what every exclusion below
 * is for. Anything positioned out of flow is excluded because that IS the way
 * an overlay is built. Anything inside an open dialog is excluded because a
 * modal is supposed to cover the page. Ancestry is excluded because a parent
 * always contains its child. What is left is two ordinary siblings in normal
 * flow occupying the same pixels, which is a defect every time.
 *
 * Same split as the clip check: one self-contained `page.evaluate` measures,
 * and a pure function rules.
 */
import type { Locator, Page } from "playwright";
import type { DeterministicFinding } from "../types.js";

/** Below this share of the smaller box, an overlap is a border or a shadow. */
const MIN_OVERLAP = 0.2;
/** Named in the finding; the rest are counted. */
const MAX_PAIRS = 5;
/** The same ceiling every other in-page walk uses. */
const MAX_ELEMENTS = 800;

/** Two elements found occupying the same pixels. Raw: nothing decided. */
export interface CollisionPair {
  /** The element painted on top, by document order and stacking. */
  topPath: string;
  topTag: string;
  topText: string;
  /** The one it covers. */
  underPath: string;
  underTag: string;
  underText: string;
  /** Share of the SMALLER box the intersection covers, 0 to 1. */
  share: number;
  /** The top element really is what paints at the intersection's centre. */
  confirmed: boolean;
}

export interface CollisionHarvest {
  pairs: CollisionPair[];
  truncated: boolean;
}

/** Runs in the browser. Self-contained: no closure over module scope. */
export function collectCollisionsInPage(args: {
  rootSelector: string | null;
  maxElements: number;
  minOverlap: number;
}): CollisionHarvest {
  const root: Element =
    (args.rootSelector ? document.querySelector(args.rootSelector) : null) ?? document.documentElement;

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

  const INTERACTIVE = ["button", "a", "input", "select", "textarea", "summary"];
  type Cand = { el: Element; rect: DOMRect; tag: string; text: string };
  const cands: Cand[] = [];
  let truncated = false;

  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (cands.length >= args.maxElements) {
      truncated = true;
      break;
    }
    const he = el as HTMLElement;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (style.opacity === "0" || style.pointerEvents === "none") continue;
    // Out of normal flow is how an overlay, a dropdown, a tooltip and a sticky
    // bar are all built. Covering something is their job, and lookout cannot
    // tell a deliberate one from an accident, so it does not try. The whole
    // ANCESTRY is checked, not the element itself: the items inside a dropdown
    // are ordinary static elements, and it is the panel around them that was
    // lifted out of flow. Checking only the element found every menu item
    // sitting on whatever the open menu covers.
    let outOfFlow = false;
    for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
      const pos = window.getComputedStyle(cur).position;
      if (pos !== "static" && pos !== "relative") {
        outOfFlow = true;
        break;
      }
    }
    if (outOfFlow) continue;
    if (el.getAttribute("aria-hidden") === "true" || he.hidden) continue;
    // A modal is meant to cover the page it is over.
    if (el.closest('[role="dialog"], [aria-modal="true"]')) continue;

    const tag = el.tagName.toLowerCase();
    const ownText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
    );
    if (!ownText && tag !== "img" && !INTERACTIVE.includes(tag)) continue;

    const rect = he.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    // Off screen is not overlapping anything a reader can see.
    if (rect.bottom < 0 || rect.right < 0) continue;
    if (rect.top > window.innerHeight * 4) continue;

    cands.push({
      el,
      rect,
      tag,
      text: (he.innerText || he.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 60),
    });
  }

  // Sorted by left edge so the scan can stop early: once a candidate starts to
  // the right of another's right edge, nothing further along can overlap it.
  cands.sort((a, b) => a.rect.left - b.rect.left);

  const pairs: CollisionPair[] = [];
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i]!;
    for (let j = i + 1; j < cands.length; j++) {
      const b = cands[j]!;
      if (b.rect.left >= a.rect.right) break;
      // A parent always contains its child, and a child never covers its
      // parent by accident.
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;

      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
      const share = smaller > 0 ? (w * h) / smaller : 0;
      if (share < args.minOverlap) continue;

      // What actually paints at the intersection settles which is on top, and
      // whether either of them is there at all: a box can intersect another
      // and be painted entirely behind it by a third.
      const cx = Math.max(a.rect.left, b.rect.left) + w / 2;
      const cy = Math.max(a.rect.top, b.rect.top) + h / 2;
      let top = a;
      let under = b;
      let confirmed = false;
      if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
        const stack = document.elementsFromPoint(cx, cy);
        const ai = stack.findIndex((n) => n === a.el || a.el.contains(n));
        const bi = stack.findIndex((n) => n === b.el || b.el.contains(n));
        if (ai !== -1 && bi !== -1) {
          confirmed = true;
          if (bi < ai) {
            top = b;
            under = a;
          }
        }
      }

      pairs.push({
        topPath: pathOf(top.el),
        topTag: top.tag,
        topText: top.text,
        underPath: pathOf(under.el),
        underTag: under.tag,
        underText: under.text,
        share: Math.round(share * 100) / 100,
        confirmed,
      });
    }
  }

  return { pairs, truncated };
}

/**
 * Which measured overlaps are defects, as at most one finding per shot.
 *
 * Only pairs the browser confirmed: an intersection the hit test could not
 * reproduce (scrolled out of the viewport, covered by a third element) is a
 * pair of rectangles, not something a reader can see going wrong.
 */
export function classifyCollisions(harvest: CollisionHarvest): DeterministicFinding[] {
  const real = harvest.pairs.filter((p) => p.confirmed).sort((a, b) => b.share - a.share);
  const worst = real[0];
  if (!worst) return [];
  const name = (text: string, tag: string): string => (text ? `"${text}"` : `a ${tag}`);
  return [
    {
      type: "box-collision",
      severity: "warning",
      message:
        `${name(worst.topText, worst.topTag)} is drawn over ${name(worst.underText, worst.underTag)}, ` +
        `covering ${Math.round(worst.share * 100)}% of it` +
        (real.length > 1 ? ` (${real.length} overlapping pairs)` : ""),
      meta: {
        offenderPath: worst.topPath,
        pairs: real.slice(0, MAX_PAIRS).map((p) => ({
          topPath: p.topPath,
          topText: p.topText,
          underPath: p.underPath,
          underText: p.underText,
          share: p.share,
        })),
        collisions: real.length,
      },
    },
  ];
}

/** Measure this shot, and rule. */
export async function checkCollisions(
  page: Page,
  element: Locator | null,
  opts: { elementSelector?: string | null } = {},
): Promise<DeterministicFinding[]> {
  const harvest = await page.evaluate(collectCollisionsInPage, {
    rootSelector: element ? opts.elementSelector ?? null : null,
    maxElements: MAX_ELEMENTS,
    minOverlap: MIN_OVERLAP,
  });
  return classifyCollisions(harvest);
}
