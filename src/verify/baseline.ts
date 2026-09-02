/**
 * What a ruling compares its fresh screenshots against.
 *
 * The pixels-moved guard says nothing may pass on unchanged pixels, so it
 * needs a "before" to compare with. That used to be whatever the capture
 * workspace held, and the workspace moves with every capture: a `lookout
 * check` between the edit and the ruling put the fixed page in it, the ruling
 * compared the fixed page to itself, and a real fix read as no change and
 * spent an attempt. The README even recommended that loop.
 *
 * The anchor is now the issue's own record, in this order per shot: the
 * capture of the previous ruling (state.json), then the frame frozen when the
 * issue was filed (the defect as filed), then the workspace and the backlog's
 * evidence as before, for shots the issue has no record of, such as the routes
 * a shell verify tops up with.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadFrames, frameAbsPath, type Frame } from "../issues/frames.js";
import { loadState, type RulingBaseline } from "../fix/state.js";
import { baselineHashes } from "./evidence.js";
import { sha256 } from "../util.js";
import type { BacklogFinding } from "../backlog/lib.js";
import type { FixCluster } from "../fix/cluster.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";

export interface BaselineDescription {
  kind: "ruling" | "frozen" | "report";
  runId?: string;
  at?: string;
}

export interface IssueBaseline {
  hashes: Map<string, string>;
  described: BaselineDescription;
}

/** A frozen frame that knows which shot it is a copy of and what its pixels hashed to. */
export type HashedFrame = Pick<Frame, "shotId" | "hash" | "at">;

/**
 * The per-shot precedence, pure: the last ruling's hash, then the frozen
 * frame's, then whatever the workspace and the backlog remember.
 */
export function issueBaseline(input: {
  ruling?: RulingBaseline;
  frozen: HashedFrame[];
  priorShots: readonly { id: string; hash: string }[];
  findings: readonly BacklogFinding[];
}): IssueBaseline {
  const hashes = baselineHashes(input.priorShots, input.findings);
  let described: BaselineDescription = { kind: "report" };
  const frozen = input.frozen.filter((f) => f.shotId && f.hash);
  if (frozen.length > 0) {
    for (const f of frozen) hashes.set(f.shotId!, f.hash!);
    described = { kind: "frozen", at: frozen[0]!.at };
  }
  if (input.ruling) {
    for (const [id, hash] of Object.entries(input.ruling.hashes)) hashes.set(id, hash);
    described = { kind: "ruling", runId: input.ruling.runId, at: input.ruling.capturedAt };
  }
  return { hashes, described };
}

/**
 * A frame frozen before shot ids and hashes were recorded: the hash is read
 * off the file, and the shot is the member photographed in the same view.
 */
async function recoverFrame(resolved: ResolvedConfig, cluster: FixCluster, f: Frame): Promise<HashedFrame> {
  if (f.shotId && f.hash) return f;
  const member = cluster.members.find(
    (m) =>
      m.route === f.route &&
      m.formFactor === f.formFactor &&
      m.scheme === f.scheme &&
      (m.state ?? "rest") === (f.state ?? "rest"),
  );
  const shotId = f.shotId ?? member?.evidence[member.evidence.length - 1]?.shotId;
  let hash = f.hash;
  const abs = frameAbsPath(resolved, cluster.id, f);
  if (!hash && existsSync(abs)) {
    try {
      hash = sha256(await readFile(abs));
    } catch {
      // An unreadable frame is no baseline; the fallbacks stand.
    }
  }
  return { at: f.at, ...(shotId ? { shotId } : {}), ...(hash ? { hash } : {}) };
}

/** The baseline for one issue, read off its own folder before the workspace is asked. */
export async function loadIssueBaseline(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  priorShots: readonly { id: string; hash: string }[],
  findings: readonly BacklogFinding[],
): Promise<IssueBaseline> {
  const [state, frames] = await Promise.all([loadState(resolved, cluster.id), loadFrames(resolved, cluster.id)]);
  const frozen = await Promise.all(frames.before.map((f) => recoverFrame(resolved, cluster, f)));
  return issueBaseline({ ruling: state.baseline, frozen, priorShots, findings });
}

/** What the next ruling compares against: every shot this ruling captured, by hash. */
export function rulingBaselineOf(shotsById: ReadonlyMap<string, ShotRecord>): RulingBaseline | undefined {
  const shots = [...shotsById.values()];
  const first = shots[0];
  if (!first) return undefined;
  return {
    runId: first.runId,
    capturedAt: first.capturedAt,
    hashes: Object.fromEntries(shots.map((s) => [s.id, s.hash])),
  };
}
