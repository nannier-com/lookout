/**
 * The overlay: what the run in flight is saying about an issue right now.
 *
 * Narration, not state, and treated as such. It is read from the events
 * directly rather than from a fold, because a log truncated by a plain `check`
 * carries nothing else to attach to, and it is laid over a board that exists
 * whether or not anything is executing.
 */
import type { LookoutEvent } from "./events.js";
import type { BoardStep } from "./board-types.js";

/**
 * The issue a `verify-fix` is judging this second, if one is, and everything
 * that run has said about it so far.
 *
 * Read from the events directly rather than from a fold, because a log
 * truncated by a plain `check` carries nothing else to attach to. The run is in
 * flight while its run-start has no matching run-end.
 */
export function liveVerify(events: LookoutEvent[]): { cluster: string | null; steps: BoardStep[] } {
  let cluster: string | null = null;
  let runId: string | null = null;
  let steps: BoardStep[] = [];
  for (const e of events) {
    if (e.kind === "run-start" && e.data?.verb === "verify-fix") {
      cluster = typeof e.data.issue === "string" ? e.data.issue : null;
      runId = e.runId;
      steps = [{ at: e.at, kind: "verify", text: "lookout started re-judging this" }];
      continue;
    }
    if (e.runId !== runId) continue;
    if (e.kind === "run-end") {
      cluster = null;
      runId = null;
      steps = [];
      continue;
    }
    // The feed tails a run in progress, so anything it says belongs on it.
    if (e.kind === "phase") steps.push({ at: e.at, kind: "verify", text: e.message });
    else if (e.kind === "shot") {
      steps.push({ at: e.at, kind: "verify", text: `re-captured ${e.message}` });
    } else if (e.kind === "finding") {
      steps.push({ at: e.at, kind: "verdict", text: `still sees ${e.message}` });
    } else if (e.kind === "verdict") {
      steps.push({ at: e.at, kind: "verdict", text: e.message });
    } else if (e.kind === "error") {
      steps.push({ at: e.at, kind: "verdict", text: e.message });
    }
  }
  return { cluster, steps };
}
