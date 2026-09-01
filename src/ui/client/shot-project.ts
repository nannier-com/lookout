/**
 * The pure half of the shot inspector: projecting a provenance sidecar's
 * element boxes onto the displayed image, and composing the hint a person
 * reads. No DOM, so tests import it directly.
 *
 * The types are a structural mirror of the sidecar contract
 * (src/capture/provenance.ts), not an import: client code may not value-import
 * the server, and a type-only mirror keeps the read contract visible where it
 * is consumed. Boxes are document-relative CSS px; the mapping authority is
 * image.width / originBox.w, exactly as the sidecar's own note states.
 */
export interface SvElement {
  tag: string;
  id: string | null;
  testid: string | null;
  text: string | null;
  cssPath: string;
  box: { x: number; y: number; w: number; h: number };
  components: string[];
  source?: { file: string; line?: number };
}

export interface SvSidecar {
  version: number;
  originBox: { x: number; y: number; w: number; h: number };
  image: { width: number; height: number };
  elements: SvElement[];
}

/** One renderable box, in percent of the image's intrinsic size. */
export interface SvBox {
  left: number;
  top: number;
  width: number;
  height: number;
  el: SvElement;
}

/** An inspection aid, not a scene graph. */
export const MAX_BOXES = 500;

/**
 * Project the sidecar onto the image: percent-of-intrinsic-size rects, so
 * boxes track any display size with no resize listener. Hinted records are
 * kept first when the cap bites; the returned order is area-descending so the
 * innermost element wins DOM hit-testing when boxes nest.
 */
export function project(sc: SvSidecar): SvBox[] {
  if (sc.version !== 1 || sc.originBox.w <= 0 || sc.image.width <= 0 || sc.image.height <= 0) {
    return [];
  }
  const scale = sc.image.width / sc.originBox.w;
  const rank = (e: SvElement): number => (e.source ? 0 : e.components.length > 0 ? 1 : 2);
  const ranked = [...sc.elements].sort((a, b) => rank(a) - rank(b));
  const out: SvBox[] = [];
  for (const el of ranked) {
    if (out.length >= MAX_BOXES) break;
    const x = (el.box.x - sc.originBox.x) * scale;
    const y = (el.box.y - sc.originBox.y) * scale;
    const w = el.box.w * scale;
    const h = el.box.h * scale;
    if (w <= 0 || h <= 0 || x >= sc.image.width || y >= sc.image.height || x + w <= 0 || y + h <= 0) {
      continue;
    }
    const cx = Math.max(0, x);
    const cy = Math.max(0, y);
    const cw = Math.min(x + w, sc.image.width) - cx;
    const ch = Math.min(y + h, sc.image.height) - cy;
    if (cw <= 0 || ch <= 0) continue;
    out.push({
      left: (cx / sc.image.width) * 100,
      top: (cy / sc.image.height) * 100,
      width: (cw / sc.image.width) * 100,
      height: (ch / sc.image.height) * 100,
      el,
    });
  }
  return out.sort((a, b) => b.width * b.height - a.width * a.height);
}

/**
 * The hint bar's line for one element: component chain, then source, then a
 * concrete handle on the DOM, then what it said.
 */
export function hintOf(e: SvElement): string {
  const chain = e.components.length > 0 ? e.components.join(" < ") : "";
  const src = e.source ? `${e.source.file}${e.source.line ? `:${e.source.line}` : ""}` : "";
  const handle = e.id
    ? `${e.tag}#${e.id}`
    : e.testid
      ? `${e.tag}[data-testid=${JSON.stringify(e.testid)}]`
      : chain || src
        ? e.tag
        : e.cssPath || e.tag;
  const said = e.text ? `  "${e.text.slice(0, 60)}"` : "";
  return [chain, src, handle].filter(Boolean).join("  ") + said;
}
