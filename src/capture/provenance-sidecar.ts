/**
 * Rendering provenance: which elements a shot rendered, where, and, where the
 * page's own dev tooling exposes it, which components and source files
 * produced them. One page.evaluate collects raw facts; everything downstream
 * of the browser (ranking, capping, sidecar assembly) is pure and unit-tested
 * without one, the harvest.ts split.
 *
 * Provenance is NOT a judge input. It describes where pixels came from, never
 * what they look like, so it enters neither the view-group hash nor any panel
 * identity: keying the cache on it would re-judge the world every time a
 * bundler changed its emitted debug hints.
 *
 * Limits, by design: production builds usually yield identity only (no
 * components, no source); shadow DOM and iframes are not walked; every
 * framework probe sits in its own try/catch so an exotic page never costs
 * the shot.
 */
import type { DeterministicFinding, ShotRecord } from "../types.js";

export const PROVENANCE_VERSION = 1;

const NOTE =
  "Per-shot rendering provenance. Overlay mapping: scale = image.width / originBox.w; " +
  "pngX = (box.x - originBox.x) * scale, same for y/w/h. Boxes are document-relative CSS px. " +
  "Not a judge input: never part of ledger or fingerprint identity.";

export interface ProvenanceElement {
  tag: string;
  id: string | null;
  testid: string | null;
  /** Explicit role attribute only. */
  role: string | null;
  /** First 5 class names, each capped. */
  classes: string[];
  /** innerText, whitespace collapsed, first 80 chars. */
  text: string | null;
  cssPath: string;
  landmark: boolean;
  /** Document-relative CSS px. */
  box: { x: number; y: number; w: number; h: number };
  /** Framework component-name chain, innermost first, up to 5. */
  components: string[];
  /** Best-effort source hint from dev tooling; absent in production builds. */
  source?: { file: string; line?: number };
}

export interface RawProvenance {
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  document: { width: number; height: number };
  /** Document-relative box of the crop root for element shots, else the document box. */
  originBox: { x: number; y: number; w: number; h: number };
  elements: ProvenanceElement[];
  /** Index into `elements` per resolve selector that matched. */
  resolved: Record<string, number>;
  truncated: boolean;
}

export interface ProvenanceSidecar extends RawProvenance {
  version: number;
  note: string;
  shotId: string;
  runId: string;
  capturedAt: string;
  /** sha256 of the PNG this sidecar describes, for drift detection. */
  shotHash: string;
  origin: "document" | "element";
  /** Actual PNG dimensions, the mapping's authority (Chromium clamps tall pages). */
  image: { width: number; height: number };
}

/** Read a shot's sidecar back; null when absent or from another version. */
export function parseSidecar(text: string): ProvenanceSidecar | null {
  try {
    const parsed = JSON.parse(text) as ProvenanceSidecar;
    return parsed.version === PROVENANCE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** An element's box in PNG pixels, per the sidecar's own mapping note. */
export function pngBoxOf(
  sidecar: Pick<ProvenanceSidecar, "image" | "originBox">,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const scale = sidecar.originBox.w > 0 ? sidecar.image.width / sidecar.originBox.w : 0;
  return {
    x: (box.x - sidecar.originBox.x) * scale,
    y: (box.y - sidecar.originBox.y) * scale,
    w: box.w * scale,
    h: box.h * scale,
  };
}

/**
 * Rank and cap what the walk collected, then wrap it as the sidecar. Source
 * hints outrank bare identity, identity outranks landmarks, landmarks outrank
 * size: when the cap bites, the records that can name code survive.
 */
export function buildSidecar(
  raw: RawProvenance,
  shot: Pick<ShotRecord, "id" | "runId" | "capturedAt" | "hash"> & {
    origin: "document" | "element";
    image: { width: number; height: number };
  },
  opts: { maxElements?: number } = {},
): ProvenanceSidecar {
  const cap = opts.maxElements ?? 300;
  const rank = (e: ProvenanceElement): number =>
    (e.source ? 0 : 8) +
    (e.components.length > 0 ? 0 : 4) +
    (e.id || e.testid ? 0 : 2) +
    (e.landmark ? 0 : 1);
  const ranked = [...raw.elements].sort(
    (a, b) => rank(a) - rank(b) || b.box.w * b.box.h - a.box.w * a.box.h,
  );
  const kept = ranked.slice(0, cap);
  // Kept indices moved, so the selector resolutions are re-pointed; a
  // resolution whose element fell to the cap is dropped rather than lied about.
  const indexOf = new Map(kept.map((e, i) => [raw.elements.indexOf(e), i]));
  const resolved: Record<string, number> = {};
  for (const [sel, i] of Object.entries(raw.resolved)) {
    const moved = indexOf.get(i);
    if (moved !== undefined) resolved[sel] = moved;
  }
  return {
    version: PROVENANCE_VERSION,
    note: NOTE,
    shotId: shot.id,
    runId: shot.runId,
    capturedAt: shot.capturedAt,
    shotHash: shot.hash,
    origin: shot.origin,
    image: shot.image,
    devicePixelRatio: raw.devicePixelRatio,
    viewport: raw.viewport,
    scroll: raw.scroll,
    document: raw.document,
    originBox: raw.originBox,
    truncated: raw.truncated || kept.length < raw.elements.length,
    elements: kept,
    resolved,
  };
}

/** One deterministic finding's element, joined at capture time. */
export interface ProvenanceRef {
  selector: string;
  cssPath: string;
  component: string | null;
  file: string | null;
  line: number | null;
}

/** The selectors a finding offers the join: axe target paths, overflow offender. */
export function selectorsOf(f: DeterministicFinding): string[] {
  if (f.type === "axe-violation" && Array.isArray(f.meta?.targets)) {
    return (f.meta.targets as unknown[]).filter((t): t is string => typeof t === "string");
  }
  if (f.type === "horizontal-overflow" && typeof f.meta?.offenderPath === "string") {
    return f.meta.offenderPath ? [f.meta.offenderPath] : [];
  }
  if (f.type === "dead-interaction" && typeof f.meta?.selector === "string") {
    return f.meta.selector ? [f.meta.selector] : [];
  }
  return [];
}

/**
 * Attach each finding's resolved elements as `meta.provenance`. The join
 * happened in the page (querySelector against the live DOM, nearest collected
 * ancestor by node identity); this maps the surviving indices back through
 * the sidecar. A selector that resolved to nothing writes nothing: an exact
 * join stays exact or stays silent.
 */
export function attachProvenance(
  findings: DeterministicFinding[],
  sidecar: Pick<ProvenanceSidecar, "resolved" | "elements">,
): void {
  for (const f of findings) {
    const refs: ProvenanceRef[] = [];
    for (const sel of selectorsOf(f).slice(0, 3)) {
      const i = sidecar.resolved[sel];
      const e = i === undefined ? undefined : sidecar.elements[i];
      if (!e) continue;
      refs.push({
        selector: sel,
        cssPath: e.cssPath,
        component: e.components[0] ?? null,
        file: e.source?.file ?? null,
        line: e.source?.line ?? null,
      });
    }
    if (refs.length > 0) {
      f.meta = { ...(f.meta ?? {}), provenance: refs };
    }
  }
}

