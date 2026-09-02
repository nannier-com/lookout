/**
 * The fresh evidence a ruling is made on, and what changed since last time.
 *
 * Re-captures and re-judges only this cluster's own routes, folds the result
 * into the backlog, and works out which screenshots actually moved. That last
 * part is load-bearing twice over, which is why it is computed once here and
 * handed to both the verdict and the acceptance criteria rather than derived
 * twice: a shot with no baseline at all is not evidence of change, it is
 * evidence of nothing, and counting it as changed is what once let a cleaned
 * evidence directory satisfy the guard that says nothing may pass on unchanged
 * pixels.
 *
 * Both channels are read back, not just the judge's. Rule violations come from
 * capture rather than from the judge, so comparing against judged findings
 * alone would pass an accessibility cluster whose violations are all still
 * firing.
 */
import { loadReport } from "../capture/store.js";
import { evidenceDir } from "../config.js";
import { classifyShots, measureMoves, snapshotBaseline } from "./moved.js";
import type { PixelDiff } from "./pixels.js";
import { runCheck } from "../verbs/check.js";
import { mergeLatest } from "../verbs/backlog.js";
import { runContactSheet } from "../verbs/capture.js";
import type { SheetResult } from "../capture/sheet.js";
import { aiToFindings, deterministicToFindings, type Backlog, type BacklogFinding } from "../backlog/lib.js";
import { inheritedByDesign } from "../backlog/adjudicate.js";
import { clusterKeyOf, clusterScope, type FixCluster } from "../fix/cluster.js";
import { panelOf } from "../judge/panels.js";
import type { CheckOutcome } from "../check/outcome.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import type { Parsed } from "../util.js";

/**
 * A finding as it comes back from a re-capture: the judge's and the
 * deterministic channel's shapes, before either has a status or a history.
 */
export type FreshFinding =
  | ReturnType<typeof aiToFindings>[number]
  | ReturnType<typeof deterministicToFindings>[number];

export interface FreshEvidence {
  resolved: ResolvedConfig;
  outcome: CheckOutcome;
  shotsById: Map<string, ShotRecord>;
  backlog: Backlog;
  /** The labelled composite of what was just re-captured. */
  sheet: SheetResult | null;
  /** Shots whose pixels moved since the previous run. */
  changedShots: Set<string>;
  /** How many shots had a baseline to compare against at all. */
  baselineShots: number;
  /**
   * How much each changed shot moved, for the shots whose baseline pixels were
   * still on hand. A changed shot missing from this map moved by an amount
   * nothing could measure, which the ruling says rather than guesses at.
   */
  changes: Map<string, PixelDiff>;
  freshDeterministic: ReturnType<typeof deterministicToFindings>;
  /** This cluster's findings that came back, minus anything ruled by-design. */
  stillOpen: FreshFinding[];
  runIdNow: string;
}

export async function gatherFreshEvidence(args: {
  parsed: Parsed;
  issueId: string;
  cluster: FixCluster;
  priorHashes: Map<string, string>;
  /** Where the baseline's pixels are, so how much moved can be measured. */
  priorPixels?: ReadonlyMap<string, string>;
  /** The target's configured routes, in config order: the shell scope's top-up. */
  configuredRoutes?: string[];
}): Promise<FreshEvidence> {
  const { parsed, issueId, cluster, priorHashes } = args;
  // Before anything captures: the capture writes each view back to the path it
  // came from, so pixels not read now are pixels nothing can compare against.
  const beforePixels = await snapshotBaseline(args.priorPixels ?? new Map());
  // 1. Re-capture and re-judge only this cluster's own routes; a shell
  // cluster widens to at least two so a one-route fix cannot pass.
  const scope = clusterScope(cluster, args.configuredRoutes ?? []);
  // An AI cluster has one category, so one judge panel owns it: pay for that
  // panel alone. The sibling panels' standing findings still surface from
  // their valid ledger entries, and moved pixels miss every panel's entry at
  // once, so closure is always backed by a fresh judgment of the member's
  // whole view group by the panel that owns its category. Deterministic and
  // code clusters get no filter: their oracle is capture or source, not a
  // panel.
  const owning = cluster.channel === "ai" ? panelOf(cluster.category).name : undefined;
  const { outcome, resolved, shotsById } = await runCheck({
    positionals: [],
    flags: {
      ...parsed.flags,
      targets: scope.targets.join(","),
      routes: scope.routes.join(","),
      // The cluster's own platform: a web issue is ruled on the web fold and
      // an iOS issue on the iOS devices, whatever else the project walks.
      ...(parsed.flags.platforms === undefined ? { platforms: cluster.platform } : {}),
      ...(owning ? { panels: owning } : {}),
    },
  });

  // The session reading this verdict should be able to see the state it was
  // reached from, so composite what was just re-captured, with the tiles that
  // still carry findings marked.
  const freshByShot = new Map<string, number>();
  for (const f of outcome.findings) freshByShot.set(f.shotId, (freshByShot.get(f.shotId) ?? 0) + 1);
  const sheet = await runContactSheet(
    resolved,
    [...shotsById.values()],
    freshByShot,
    `verify-${issueId}.png`,
  );

  // 2. Fold the fresh evidence into the backlog, then read the answer off it.
  const merged = await mergeLatest(resolved, { judgeOutcome: outcome });

  // Both channels, or a deterministic cluster could never fail. Rule violations
  // (every axe finding) come back from capture, not from the judge, so
  // comparing against judged findings alone would pass an accessibility cluster
  // whose violations are all still firing.
  const report = await loadReport(resolved);
  const latestRun = report?.runs[report.runs.length - 1];
  const latestShots = new Set(
    (report?.shots ?? []).filter((sh) => sh.runId === latestRun?.id).map((sh) => sh.id),
  );
  // What moved, and by how much. A shot with no baseline at all is not
  // evidence of change: it is evidence of nothing. Counting it as changed is
  // what let a cleaned evidence directory satisfy the guard.
  const measured = await measureMoves({
    shots: shotsById.values(),
    priorHashes,
    before: beforePixels,
    evidenceDir: evidenceDir(resolved),
  });
  const { changedShots, baselineShots, changes } = classifyShots({
    shots: [...shotsById.values()],
    priorHashes,
    measured,
  });

  const freshDeterministic = report
    ? deterministicToFindings(
        {
          ...report,
          shots: report.shots.filter((sh) => latestShots.has(sh.id) && shotsById.has(sh.id)),
        },
        { shellIdentity: resolved.config.shellScoping === true },
      )
    : [];
  const fresh = [
    ...aiToFindings(outcome.findings, shotsById, {
      shellIdentity: resolved.config.shellScoping === true,
    }),
    ...freshDeterministic,
  ];
  const backlog = merged.backlog;
  const stillOpen = withoutByDesign(
    fresh.filter((f) => clusterKeyOf(f) === cluster.key),
    backlog,
  );
  const runIdNow = outcome.runId;

  return {
    resolved,
    outcome,
    shotsById,
    backlog,
    sheet,
    changedShots,
    baselineShots,
    changes,
    freshDeterministic,
    stillOpen,
    runIdNow,
  };
}

/**
 * Every shot lookout holds a previous hash for, from either source.
 *
 * The capture workspace, inside the project's `.lookout/`, is working state
 * one capture rebuilds, and an empty baseline made every fresh shot look
 * changed, which switched the pixels-moved guard OFF exactly when it was
 * needed: a wiped capture workspace would let judge variance alone pass an
 * issue. backlog.json is committed and its evidence refs carry the hash each
 * finding was filed against, so they outlive the pixels. The report is
 * fresher, so it wins where both know a shot.
 */
export function baselineHashes(
  priorShots: readonly { id: string; hash: string }[],
  findings: readonly BacklogFinding[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of findings) {
    // Later refs win: evidence is appended in capture order.
    for (const ev of f.evidence) out.set(ev.shotId, ev.hash);
  }
  for (const sh of priorShots) out.set(sh.id, sh.hash);
  return out;
}

/**
 * Drop findings somebody already ruled intentional.
 *
 * A by-design sibling under an issue's own cluster key re-fires on every
 * capture, because an intentional defect is still there by definition. Counting
 * it held the issue open however well the real defect had been fixed, and then
 * blocked it with a reason claiming a defect persists that somebody had already
 * ruled intended. `mergeFindings` suppresses these; the verdict has to as well.
 */
export function withoutByDesign<
  T extends { fingerprint: string } & Parameters<typeof inheritedByDesign>[1],
>(fresh: readonly T[], backlog: Backlog): T[] {
  const byDesign = new Set(
    Object.values(backlog.findings)
      .filter((f) => f.status === "by-design")
      .map((f) => f.fingerprint),
  );
  // The issue-level ruling reaches here too: a fresh sibling under a
  // by-design issue must not hold a verdict open any more than a per-finding
  // ruling does. mergeFindings creates it as by-design; the verdict agrees.
  for (const f of fresh) {
    if (!byDesign.has(f.fingerprint) && inheritedByDesign(backlog, f)) {
      byDesign.add(f.fingerprint);
    }
  }
  return fresh.filter((f) => !byDesign.has(f.fingerprint));
}
