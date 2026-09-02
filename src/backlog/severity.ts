/**
 * What severity lookout opens a measured finding at.
 *
 * Its own module because two callers need the same answer and neither may
 * import the other: ingestion assigns it, and the prose that explains the
 * finding names it. They used to disagree. The impact sentence said an axe
 * rating of `serious` means "lookout files as high", which is true of every
 * axe rule except the one that is capped, so a target-size ticket printed
 * "severity medium" four lines above prose asserting it was filed as high.
 */
import type { DeterministicFinding, Severity } from "../types.js";

export function severityFromDeterministic(f: DeterministicFinding): Severity {
  // Both mean the pixels are not the thing the shot claims to be, which makes
  // every other finding on that shot describe the wrong screen.
  if (f.type === "blank-shot" || f.type === "off-origin") return "critical";
  // Control size is measured from the element's own box, and a box is not the
  // hit area: an icon button whose parent carries the padding measures small
  // and is perfectly usable. axe rates the rule serious, which would open it
  // at high, and nothing refutes a deterministic finding, so it would sit at
  // the top of the backlog with no second opinion available. Capped at medium,
  // which is where a real one still gets read and a false one costs little.
  if (f.type === "axe-violation" && f.meta?.ruleId === "target-size") return "medium";
  if (f.severity === "error") return "high";
  if (f.severity === "warning") return "medium";
  return "low";
}
