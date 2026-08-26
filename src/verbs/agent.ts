/**
 * `lookout agent`: who is working which cluster, right now.
 *
 * lookout dispatches work but never starts it: a fix session is a child of
 * whichever harness is driving the run, in a process lookout cannot see. So
 * between a dispatch and the verdict that closes it, lookout has no idea
 * whether a cluster is untouched or has had an agent on it for twenty minutes.
 * That gap is the whole reason a board of dispatched work reads as a wall of
 * identical rows.
 *
 * This verb closes it, at the cost of one line in the dispatch protocol. The
 * session announces a subagent as it spawns one and again when it replies, and
 * both facts land on the same event log the board is folded from. Nothing here
 * adjudicates: an agent saying it is done is a claim, and `verify-fix` remains
 * the only thing that rules on whether the defect is gone.
 *
 * Reporting is optional by construction. A harness that never calls this leaves
 * its cards at `queued`, which is exactly what lookout knew before.
 */
import { loadConfig } from "../config.js";
import { EventLog, readEvents, summarise, setCurrentLog } from "../report/events.js";
import { loadState, saveState, type AgentSession } from "../fix/state.js";
import { LookoutError } from "../types.js";
import { nowIso, printJson, runId as makeRunId, str, type Parsed } from "../util.js";

const ACTIONS = ["start", "note", "done", "list"] as const;
type Action = (typeof ACTIONS)[number];

/** The stint still running, if any: the last one nobody has closed. */
function openSession(sessions: AgentSession[]): AgentSession | undefined {
  const last = sessions[sessions.length - 1];
  return last && !last.finishedAt ? last : undefined;
}

export async function agent(parsed: Parsed): Promise<number> {
  const action = (parsed.positionals[0] ?? "list") as Action;
  if (!ACTIONS.includes(action)) {
    throw new LookoutError(
      `unknown agent action "${action}"`,
      `one of: ${ACTIONS.join(", ")}`,
    );
  }

  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
  });

  if (action === "list") {
    const s = summarise(readEvents(resolved));
    if (parsed.flags.json) {
      printJson({ board: s.board, agents: s.agents });
      return 0;
    }
    if (s.board.length === 0) {
      console.log("nothing dispatched yet (run `lookout check --auto`)");
      return 0;
    }
    for (const e of s.board) {
      const who = e.agent ? `  ${e.agent.name}` : "";
      console.log(`${e.status.padEnd(11)} ${e.id}${who}`);
      if (e.agent) {
        console.log(
          `  started ${e.agent.startedAt.slice(11, 19)}` +
            (e.agent.finishedAt ? `, finished ${e.agent.finishedAt.slice(11, 19)}` : "") +
            (e.agent.commit ? `, commit ${e.agent.commit}` : ""),
        );
      }
    }
    return 0;
  }

  const clusterId = str(parsed.flags.cluster) ?? parsed.positionals[1];
  if (!clusterId) {
    throw new LookoutError(
      `agent ${action} needs --cluster <id>`,
      "ids come from `lookout check --auto`, or `lookout agent list`",
    );
  }

  const state = await loadState(resolved, clusterId);
  const sessions = state.sessions ?? [];
  const at = nowIso();
  const name = str(parsed.flags.name);

  // Attach to the board the dispatching run defined, without opening a run of
  // our own. Starting a fresh log here would erase every other cluster's
  // dispatch; opening a run would leave the board showing one in flight that
  // never ends, because reporting is instantaneous and has no end to emit.
  const elog = new EventLog(resolved, makeRunId("agent"));
  elog.attach();
  setCurrentLog(elog);

  let session: AgentSession | undefined;
  let message: string;

  switch (action) {
    case "start": {
      session = {
        name: name ?? clusterId,
        startedAt: at,
        lastSeenAt: at,
        notes: [],
      };
      sessions.push(session);
      message = `${session.name} started on ${clusterId}`;
      elog.emit("agent-start", message, { cluster: clusterId, name: session.name });
      break;
    }
    case "note": {
      const text = str(parsed.flags.note) ?? parsed.positionals.slice(1).join(" ");
      if (!text) {
        throw new LookoutError(
          "agent note needs something to say",
          'lookout agent note --cluster <id> --note "reading the brief"',
        );
      }
      session = openSession(sessions);
      if (!session) {
        // A note without a start still carries information, so open a stint
        // rather than drop it: somebody is evidently on this cluster.
        session = { name: name ?? clusterId, startedAt: at, lastSeenAt: at, notes: [] };
        sessions.push(session);
        elog.emit("agent-start", `${session.name} started on ${clusterId}`, {
          cluster: clusterId,
          name: session.name,
        });
      }
      session.lastSeenAt = at;
      session.notes.push({ at, text });
      message = text;
      elog.emit("agent-note", text, { cluster: clusterId, name: session.name });
      break;
    }
    case "done": {
      const commit = str(parsed.flags.commit);
      const note = str(parsed.flags.note);
      session = openSession(sessions);
      if (!session) {
        session = { name: name ?? clusterId, startedAt: at, lastSeenAt: at, notes: [] };
        sessions.push(session);
      }
      if (name) session.name = name;
      session.lastSeenAt = at;
      session.finishedAt = at;
      session.reported = {
        ...(commit ? { commit } : {}),
        ...(note ? { note } : {}),
      };
      message =
        `${session.name} reported back on ${clusterId}` + (commit ? ` (commit ${commit})` : "");
      elog.emit("agent-done", message, {
        cluster: clusterId,
        name: session.name,
        ...(commit ? { commit } : {}),
        ...(note ? { note } : {}),
      });
      break;
    }
  }

  await saveState(resolved, { ...state, sessions });
  setCurrentLog(null);

  const payload = {
    cluster: clusterId,
    action,
    agent: session.name,
    at,
    ...(action === "done"
      ? {
          next:
            "run `lookout verify-fix --cluster " +
            clusterId +
            '` with the commit and root cause it reported. A session saying it is done ' +
            "does not close a finding.",
        }
      : {}),
  };

  if (parsed.flags.json) printJson(payload);
  else {
    console.log(message);
    if (action === "done") console.log(`  next: ${payload.next}`);
  }
  return 0;
}
