/**
 * The measured facts about a shot, as the lines a prompt carries.
 *
 * These are the one thing in this pipeline that IS a measurement. axe knows the
 * rule that fired, the overflow and clip checks know the element and the
 * amount. Giving them to a model that cannot measure is free precision, and it
 * localizes: "something is cut off here" plus a selector beats hunting an
 * image.
 *
 * Its own module because two different prompts need the same lines and must not
 * drift: the judge builds a manifest of shots, and the refuter is handed one
 * finding at a time. A copy in each would be two answers to one question.
 */
import type { ShotRecord } from "../types.js";

/** At most this many deterministic signals per shot in a judge manifest. */
export const MAX_SIGNALS = 3;

/**
 * One shot's deterministic findings, compactly.
 *
 * Informational findings are deliberately excluded: a signal is something that
 * fired, and dressing up a note as one would have the judge chasing it.
 */
export function signalsLine(shot: ShotRecord, cap = MAX_SIGNALS): string {
  const parts = shot.deterministicFindings
    .filter((f) => f.severity !== "info")
    .slice(0, cap)
    .map((f) => `${f.type}: ${f.message.slice(0, 120)}`);
  return parts.length > 0 ? parts.join(" | ") : "";
}

/**
 * What in this frame scrolls sideways, and how much of it is off screen.
 *
 * Not a finding and never one: a table whose last column sits past the frame's
 * edge inside a scroller is reachable, and a reader who drags it sees the rest.
 * Without being told, a model looking at the still has no way to tell that from
 * content that is genuinely lost, and both readings are one sentence away from
 * a filed defect. The clip check is silent about the same elements for the same
 * reason; this is the half that says so out loud.
 */
export function scrollerLine(shot: ShotRecord): string {
  const parts = (shot.scrollers ?? [])
    .slice(0, 3)
    .map((s) => `${s.tag}${s.path ? ` (${s.path.slice(0, 60)})` : ""} hides ${s.hiddenWidth}px`);
  return parts.length > 0
    ? `scrolls sideways, so content past its edge is reachable: ${parts.join(" | ")}`
    : "";
}
