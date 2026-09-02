/**
 * Everything the issue's renderings read, loaded once.
 *
 * The document and the JSON record are two projections of one issue, and they
 * used to gather their inputs separately: the same frames read twice, the same
 * git remote asked twice. One context, built once per issue, is what keeps the
 * two from drifting: a fact either is in here, and both can print it, or it is
 * in neither.
 */
import { evidenceDir } from "../config.js";
import { loadFrames, type FrameSet } from "./frames.js";
import { forgeOf, type Forge } from "../report/forge.js";
import type { FixCluster } from "../fix/cluster.js";
import type { IssueRecord } from "../backlog/lib.js";
import type { ResolvedConfig } from "../types.js";

/** The slice of the issue record a rendering reads. */
export type IssueRecordView = Pick<IssueRecord, "acceptance" | "causedBy" | "placement">;

export interface IssueContext {
  resolved: ResolvedConfig;
  cluster: FixCluster;
  record?: IssueRecordView;
  /** The capture workspace, absolute. */
  evDir: string;
  /** The frames frozen into this issue's own folder. */
  frames: FrameSet;
  /**
   * The repository's forge, asked for at most once and only when a section
   * needs a commit URL: it runs git, and most issues have no fix to link yet.
   */
  forge: () => Promise<Forge | null>;
}

export async function loadIssueContext(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  record?: IssueRecordView,
): Promise<IssueContext> {
  const frames = await loadFrames(resolved, cluster.id);
  let forge: Promise<Forge | null> | null = null;
  return {
    resolved,
    cluster,
    record,
    evDir: evidenceDir(resolved),
    frames,
    forge: () => (forge ??= forgeOf(resolved.projectDir)),
  };
}
