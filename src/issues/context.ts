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
import { loadReport } from "../capture/store.js";
import { loadPlans, type NavigationFile } from "../navigate/store.js";
import { loadLedger, type Ledger } from "../judge/ledger.js";
import { loadFrames, type FrameSet } from "./frames.js";
import { loadState, type ClusterState } from "../fix/state.js";
import { forgeOf, type Forge } from "../report/forge.js";
import type { FixCluster } from "../fix/cluster.js";
import type { Backlog, IssueRecord } from "../backlog/lib.js";
import type { CaptureReport, ResolvedConfig, RunRecord, ShotRecord } from "../types.js";

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
   * Every attempt lookout has ruled on. Truth written by verify-fix, never
   * regenerated; read here so the document can say what has been tried.
   */
  state: ClusterState;
  /**
   * The capture workspace's report, when it is still there. Working state that
   * any capture rebuilds, so every section reading it degrades to what the
   * config says when it is gone: the document never fails for a cleaned
   * workspace.
   */
  report: CaptureReport | null;
  /**
   * The navigation plans lookout has made for this project, when it has any:
   * what a state other than rest is, and what was clicked to reach it.
   */
  plans: NavigationFile | null;
  /**
   * The judge ledger, for the transcripts behind this issue's views. Absent
   * when the project has none yet.
   */
  ledger: Ledger | null;
  /**
   * The whole backlog, when the caller has it open: what lets a document name
   * the other issues filed on the same screenshot. A caller rendering one
   * issue in isolation leaves it out, and the section is simply absent.
   */
  backlog?: Backlog;
  /**
   * The repository's forge, asked for at most once and only when a section
   * needs a commit URL: it runs git, and most issues have no fix to link yet.
   */
  forge: () => Promise<Forge | null>;
}

/** What a caller can hand the renderer beyond the issue itself. */
export interface IssueExtras {
  backlog?: Backlog;
}

export async function loadIssueContext(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  record?: IssueRecordView,
  extras: IssueExtras = {},
): Promise<IssueContext> {
  const [frames, state, report, plans, ledger] = await Promise.all([
    loadFrames(resolved, cluster.id),
    loadState(resolved, cluster.id),
    loadReport(resolved).catch(() => null),
    loadPlans(resolved).catch(() => null),
    loadLedger(resolved).catch(() => null),
  ]);
  let forge: Promise<Forge | null> | null = null;
  return {
    resolved,
    cluster,
    record,
    evDir: evidenceDir(resolved),
    frames,
    state,
    report,
    plans,
    ledger,
    ...(extras.backlog ? { backlog: extras.backlog } : {}),
    forge: () => (forge ??= forgeOf(resolved.projectDir)),
  };
}

/** The recorded shot behind a member's newest evidence, when the report still has it. */
export function shotOf(ctx: IssueContext, shotId: string): ShotRecord | undefined {
  return ctx.report?.shots.find((s) => s.id === shotId);
}

/**
 * The run that produced the issue's newest evidence: what flags the filing
 * capture ran with, and when. Absent once the workspace has been rebuilt by a
 * capture that did not include it.
 */
export function filingRunOf(ctx: IssueContext): RunRecord | undefined {
  const runIds = ctx.cluster.members.map((m) => m.evidence[m.evidence.length - 1]?.runId).filter(Boolean);
  const runs = ctx.report?.runs ?? [];
  return [...runs].reverse().find((r) => runIds.includes(r.id));
}
