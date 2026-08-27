/**
 * `lookout status`: what the run in flight is doing, right now.
 *
 * A session that starts `lookout check` in the background sees nothing until
 * the process exits. Polling this costs one cheap read and answers the only
 * question that matters mid-run: how far along, what has been found, and
 * where each issue stands.
 */
import { loadConfig } from "../config.js";
import { readEvents, summarise, type LookoutEvent } from "../report/events.js";
import { buildBoard, tally } from "../report/board.js";
import { num, printJson, str, type Parsed } from "../util.js";

/**
 * How long a run may say nothing before it is presumed dead. A judge batch can
 * take three minutes on a slow model, and a capture with a sign-in hook longer,
 * so this is deliberately generous: it exists to catch runs that were killed,
 * not runs that are merely slow.
 */
export const STALE_MS = 10 * 60 * 1000;

function elapsed(from: string, to: string | null): string {
  const ms = new Date(to ?? new Date().toISOString()).getTime() - new Date(from).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export async function status(parsed: Parsed): Promise<number> {
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
  });
  const events = readEvents(resolved);
  const run = summarise(events);
  // Outstanding work comes from the backlog, not the log: a capture truncates
  // the log, and the work outlives the run that found it.
  const board = await buildBoard(resolved, events);
  const s = { ...run, board, agents: tally(board) };

  if (parsed.flags.json) {
    const tail = num(parsed.flags.tail);
    printJson({ ...s, ...(tail ? { recent: events.slice(-tail) } : {}) });
    return s.running ? 1 : 0;
  }

  if (!s.runId && s.board.length === 0) {
    console.log("no run recorded yet (run `lookout check`)");
    return 0;
  }
  if (!s.runId) {
    // The log was truncated or never written, but the backlog remembers.
    console.log(`no run in flight; ${s.board.length} issue(s) on record`);
  }

  // A run that died without emitting `run-end` stays `running` in the log. Say
  // how long it has been silent rather than reporting a dead run as live.
  const silentFor = s.lastEventAt
    ? Date.now() - new Date(s.lastEventAt).getTime()
    : 0;
  const stalled = s.running && silentFor > STALE_MS;
  if (s.runId) console.log(
    `${stalled ? "STALLED" : s.running ? "RUNNING" : "done"}  ${s.runId}  phase: ${s.phase}` +
      (s.startedAt ? `  elapsed: ${elapsed(s.startedAt, s.endedAt)}` : "") +
      (stalled ? `  silent for ${elapsed(s.lastEventAt!, null)}` : ""),
  );
  console.log(
    `  ${s.shots} shot(s) captured` +
      (s.batches.total ? `; batches ${s.batches.done}/${s.batches.total}` : ""),
  );
  console.log(
    `  findings: ${s.findings.total}` +
      ` (${s.findings.critical} critical, ${s.findings.high} high,` +
      ` ${s.findings.medium} medium, ${s.findings.low} low)`,
  );
  if (s.board.length > 0) {
    const t = s.agents;
    console.log(
      `  issues: ${t.open} open` +
        (t.verifying ? `, ${t.verifying} being re-judged` : "") +
        // Blocked is not settled: lookout gave up on these and they still need
        // fixing, so they are named rather than folded into a done-pile.
        (t.blocked ? `, ${t.blocked} BLOCKED (out of attempts)` : "") +
        (t.done ? `, ${t.done} done` : "") +
        (t.archived ? `, ${t.archived} archived` : ""),
    );
  }
  for (const b of s.board) {
    console.log(`  ${b.status.padEnd(11)} ${b.id}  ${b.label}`);
    // Absolute, because whoever picks this up needs a path they can open
    // without knowing where lookout keeps its evidence.
    for (const sh of b.shots.slice(0, 3)) console.log(`    ${sh.absPath}`);
    if (b.judgeNote) console.log(`    judge: ${b.judgeNote}`);
  }
  for (const e of s.errors.slice(-5)) console.log(`  ERROR ${e}`);
  if (s.lastMessage) console.log(`  last: ${s.lastMessage}`);

  const recent = num(parsed.flags.tail);
  if (recent) {
    console.log("");
    for (const e of events.slice(-recent) as LookoutEvent[]) {
      console.log(`  ${e.at.slice(11, 19)} ${e.kind.padEnd(12)} ${e.message}`);
    }
  }
  return s.running ? 1 : 0;
}
