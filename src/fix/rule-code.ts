/**
 * Ruling on a source finding.
 *
 * `verify-fix` normally re-captures and re-judges: it photographs the routes
 * again and asks whether the defect is still visible. A code-channel finding
 * cannot be ruled that way. Nothing about a hand-rolled duplicate is visible in
 * a screenshot; that is the point of it, and it is why a screenshot oracle has
 * no business filing one in the first place.
 *
 * So the code channel brings its own oracle. The scanner that filed the finding
 * is re-run against the source as it stands, and the finding is closed when the
 * scanner no longer sees it. That keeps the contract lookout is built on
 * exactly as strict as it is everywhere else: the fixer does not get to say the
 * defect is gone, lookout looks again and decides.
 *
 * It is stricter in one way, in fact. The visual path has to guard against
 * judge variance, which is why it refuses to pass on unchanged pixels. The
 * scanner is deterministic, so an unchanged file gives an unchanged answer and
 * no such guard is needed: if the finding is gone, something really changed.
 */
import { detect } from "../design/detect.js";
import { primaryKit } from "../design/inventory.js";
import { handRollsToFindings } from "../backlog/lib.js";
import { clusterKeyOf } from "./cluster.js";
import type { FixCluster } from "./cluster.js";
import type { ResolvedConfig } from "../types.js";

export interface CodeRuling {
  /** True when the scanner no longer sees this finding anywhere. */
  cleared: boolean;
  /** What it still sees, when it still sees something. */
  note: string;
  /** How many of the cluster's findings are still present. */
  stillOpen: number;
  /** Whether the file the finding was in still exists and was read. */
  scanned: boolean;
}

/**
 * Re-read the source and decide whether this cluster's findings are still
 * there. Never edits, never runs the project: it reads files, exactly as the
 * scan that filed the finding did.
 */
export async function ruleCodeCluster(
  resolved: ResolvedConfig,
  cluster: FixCluster,
): Promise<CodeRuling> {
  // Deliberately a fresh scan, never the cache: the cache is what the tree
  // looked like before the fix, and ruling a fix against a pre-fix snapshot
  // would pass or fail on stale evidence.
  const inv = await detect(resolved);
  const kit = primaryKit(inv);

  // The kit going away entirely is a legitimate clearing of a hand-roll
  // finding: with no design system there is nothing left to duplicate. Saying
  // so is better than reporting zero findings without explaining why.
  if (!kit) {
    return {
      cleared: true,
      note: "the project no longer resolves to a design system, so there is nothing left for this component to duplicate",
      stillOpen: 0,
      scanned: true,
    };
  }

  const fresh = handRollsToFindings(inv.handRolls, kit.name, cluster.target);
  const still = fresh.filter((f) => clusterKeyOf(f) === cluster.key);

  return {
    cleared: still.length === 0,
    note:
      still.length === 0
        ? ""
        : `the source scan still sees it: ${still[0]!.observed}`,
    stillOpen: still.length,
    scanned: true,
  };
}
