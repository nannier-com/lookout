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
 *
 * The channel has two oracles, and this is where that matters most. A defect
 * the conformance skill found lives in a file the scanner cleared, usually
 * because the file imports the kit, which is the one thing that makes the
 * scanner look away. Ruling such a finding by re-running the scanner would
 * clear it the first time anybody asked, with nothing fixed and a commit
 * recorded against it. So a cluster carrying skill-found members is re-read by
 * the skill, over the files those members name, and a reader that cannot run
 * leaves the finding open rather than passing it.
 */
import { repoRootOf } from "../design/detect.js";
import { resolveInventory } from "../design/resolve.js";
import { primaryKit } from "../design/inventory.js";
import { readConformance } from "../design/conformance.js";
import { handRollsToFindings } from "../backlog/lib.js";
import { clusterKeyOf } from "./cluster.js";
import type { FixCluster } from "./cluster.js";
import type { ResolvedConfig } from "../types.js";

export interface CodeRuling {
  /** True when no oracle that filed this cluster still sees it. */
  cleared: boolean;
  /** What is still seen, when something is. */
  note: string;
  /** How many of the cluster's findings are still present. */
  stillOpen: number;
  /** Whether the file the finding was in still exists and was read. */
  scanned: boolean;
  /** What the conformance re-read cost, when one was needed. */
  costUsd?: number;
}

export interface CodeRulingOptions {
  /** Model for the conformance re-read; only spent when the skill filed a member. */
  model?: string;
}

/**
 * Re-read the source and decide whether this cluster's findings are still
 * there. Never edits, never runs the project: it reads files, exactly as the
 * scan that filed the finding did.
 */
export async function ruleCodeCluster(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  opts: CodeRulingOptions = {},
): Promise<CodeRuling> {
  // Deliberately a fresh scan, never the cache: the cache is what the tree
  // looked like before the fix, and ruling a fix against a pre-fix snapshot
  // would pass or fail on stale evidence. Resolved the same way FILING
  // resolves it, declaration applied: this used to call raw detect(), so a
  // kit that existed only as a config declaration filed findings on `check`
  // and auto-passed them here, having read nothing. persist: false because a
  // ruling has no business rewriting the project's inventory.
  const inv = await resolveInventory(resolved, { refresh: true, persist: false });
  const kit = primaryKit(inv);

  // No kit, by detection or declaration, never auto-passes. Genuinely gone
  // and merely undetectable are indistinguishable from inside a ruling, and
  // they demand opposite verdicts, so the ruling refuses both and routes the
  // genuine case to the channel that records intentional states.
  if (!kit) {
    return {
      cleared: false,
      note:
        "the design system this issue was filed against no longer resolves (no detection hit, no config " +
        "declaration). If it was removed on purpose, adjudicate this issue by-design with that reason; " +
        "if not, the detection or declaration is broken and this pass must not close anything",
      stillOpen: cluster.fingerprints.length,
      scanned: false,
    };
  }

  const fresh = handRollsToFindings(inv.handRolls, kit.name, cluster.target);
  const still = fresh.filter((f) => clusterKeyOf(f) === cluster.key);
  if (still.length > 0) {
    return {
      cleared: false,
      note: `the source scan still sees it: ${still[0]!.observed}`,
      stillOpen: still.length,
      scanned: true,
    };
  }

  // A member that names no source file cannot be re-checked by either oracle.
  // Clearing it would close a defect nothing looked at, which is the one
  // outcome this channel must never produce.
  const unrecheckable = cluster.members.filter(
    (m) => m.source?.foundBy !== "scan" && !m.source?.path,
  );
  if (unrecheckable.length > 0) {
    return {
      cleared: false,
      note:
        "this finding names no source file, so it cannot be re-checked mechanically; " +
        "adjudicate it, or re-file it from a fresh check",
      stillOpen: cluster.fingerprints.length,
      scanned: false,
    };
  }

  // The files this cluster's non-scanner members live in. Provenance the
  // conservative way round: a member with no recorded `foundBy` predates the
  // provenance field, and the scanner BY DESIGN cannot see what the skill
  // files, so scanner silence about such a member proves nothing. It costs one
  // skill re-read, once; reading it as scan-found closed defects unread.
  // Nothing else is re-read: a conformance sweep of the whole application to
  // rule on one issue would cost a run's worth of model calls to answer a
  // question about one file.
  const files = [
    ...new Set(
      cluster.members
        .filter((m) => m.source?.path && m.source.foundBy !== "scan")
        .map((m) => m.source!.path),
    ),
  ];
  if (files.length === 0) {
    return { cleared: true, note: "", stillOpen: 0, scanned: true };
  }

  const repoRoot = await repoRootOf(resolved.projectDir);
  const read = await readConformance(resolved, inv, repoRoot, {
    only: files,
    model: opts.model,
  });
  // A file with no verdict has not been cleared. Passing here would close a
  // defect because a subprocess failed or a reply skipped a file, which is the
  // one outcome this channel must never produce. A cache hit is a verdict, so
  // this asks what came back rather than whether a call was made.
  if (read.unread.length > 0) {
    return {
      cleared: false,
      note: "the conformance reader could not re-read this file, so the finding stands",
      stillOpen: cluster.fingerprints.length,
      scanned: false,
      costUsd: read.costUsd,
    };
  }

  const reread = handRollsToFindings(read.handRolls, kit.name, cluster.target).filter(
    (f) => clusterKeyOf(f) === cluster.key,
  );
  return {
    cleared: reread.length === 0,
    note:
      reread.length === 0
        ? ""
        : `the conformance reader still sees it: ${reread[0]!.observed}`,
    stillOpen: reread.length,
    scanned: true,
    costUsd: read.costUsd,
  };
}
