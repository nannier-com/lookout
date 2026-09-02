/**
 * The measured facts about one shot, for the participant whose whole job is to
 * doubt a claim about it.
 *
 * The adversarial verifier is handed a claim, a screenshot, and an instruction
 * to lean refuted when uncertain. That is the right instinct and it has a cost:
 * the findings hardest to see in a still are the ones it kills, and some of
 * them are real. Two refutations in the one stored run read "no avatar fragment
 * is visible, presumably a deliberate mobile simplification" about a control
 * whose box sat past the right edge of the document, which lookout had measured
 * and never showed it.
 *
 * So the brief carries only facts lookout took itself: the frame's size, and
 * the elements whose boxes leave it. Nothing here is inferred and nothing is
 * about appearance, which is the line that keeps this from becoming a second
 * judge. A number the judge wrote in its own prose stays what it always was:
 * invented, and refutable on exactly that ground.
 */
import { loadSidecarBeside, type ProvenanceSidecar } from "../capture/provenance-sidecar.js";
import type { ShotRecord } from "../types.js";

/** Elements named in the brief; past this it is a manifest, not a corroboration. */
const MAX_ELEMENTS = 6;

/** How far past an edge a box must sit before it is worth saying. */
const SLACK = 2;

function describe(e: ProvenanceSidecar["elements"][number]): string {
  const name = e.text ? `"${e.text.slice(0, 40)}"` : e.id ? `#${e.id}` : e.tag;
  return `${name} (${e.tag}) spans x ${Math.round(e.box.x)} to ${Math.round(e.box.x + e.box.w)}`;
}

/**
 * The geometry brief for one shot, or "" when there is nothing measured to say.
 *
 * Built from the sidecar lookout already writes at capture, so it costs a file
 * read and no model money. Absent sidecar, absent brief: a project that turned
 * provenance off is simply not offered this, and the refuter works as before.
 */
export function measuredBrief(shot: ShotRecord, evidenceDir: string): string {
  if (!shot.provenance) return "";
  const sidecar = loadSidecarBeside(evidenceDir, shot.path);
  if (!sidecar) return "";

  const width = sidecar.document.width;
  const outside = sidecar.elements
    .filter((e) => e.box.x + e.box.w > width + SLACK || e.box.x < -SLACK)
    .sort((a, b) => b.box.x + b.box.w - (a.box.x + a.box.w))
    .slice(0, MAX_ELEMENTS);
  if (outside.length === 0) return "";

  return [
    `the page is ${Math.round(width)}px wide here, and lookout measured ${outside.length === 1 ? "one element" : `${outside.length} elements`} outside it:`,
    ...outside.map((e) => `     - ${describe(e)}`),
  ].join("\n     ");
}
