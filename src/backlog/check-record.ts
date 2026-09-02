/**
 * What a finding keeps of the check and the capture behind it.
 *
 * A deterministic finding used to survive ingestion as an attribute, a region
 * and one rendering element; the rest of what the check recorded (every
 * element a rule fired on, the error's location, the offending path) was
 * written into prose once and then gone. Kept here, bounded, it can be listed
 * in the document and re-explained without a re-capture. The bounds matter
 * because backlog.json is committed with the project: a rule that fires on a
 * thousand elements is a thousand elements the check knows about, not a
 * thousand lines in git.
 */
import type { CheckRecord, ViewFacts } from "./lib.js";
import type { DeterministicFinding, ShotRecord } from "../types.js";

const MAX_STRING = 400;
const MAX_ITEMS = 20;
const MAX_DEPTH = 2;

/**
 * Depth counts objects, not lists: a list of elements each carrying a list
 * of check messages is the shape axe hands over, and it is two objects deep.
 */
function bound(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => bound(x, depth)).filter((x) => x !== undefined);
  if (typeof v === "object" && depth < MAX_DEPTH) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const b = bound(x, depth + 1);
      if (b !== undefined) out[k] = b;
    }
    return out;
  }
  return undefined;
}

/**
 * The check's record, minus the provenance join, which the finding already
 * carries as `renderedBy` and which is a list of selectors the sidecar
 * describes better.
 */
export function checkRecordOf(df: DeterministicFinding): CheckRecord {
  if (!df.meta) return { type: df.type };
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(df.meta)) {
    if (k === "provenance") continue;
    const b = bound(v);
    if (b !== undefined) meta[k] = b;
  }
  return Object.keys(meta).length > 0 ? { type: df.type, meta } : { type: df.type };
}

const VIEW_KEYS: (keyof ViewFacts)[] = [
  "url",
  "finalUrl",
  "viewport",
  "dpr",
  "schemeMechanism",
  "element",
  "stateDescription",
  "stateAffordance",
  "design",
  "designHash",
  "provenance",
];

/** The facts about the view the shot record carries, when it carries any. */
export function viewOf(shot: ShotRecord): { view?: ViewFacts } {
  const view: ViewFacts = {};
  for (const k of VIEW_KEYS) {
    const v = shot[k as keyof ShotRecord];
    if (v !== undefined && v !== null) (view as Record<string, unknown>)[k] = v;
  }
  return Object.keys(view).length > 0 ? { view } : {};
}
