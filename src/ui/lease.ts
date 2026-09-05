/**
 * Who is holding the queue right now.
 *
 * The queue hands one issue over at a time, and until this file existed its
 * only notion of "still being worked on" was lookout's own record: an issue was
 * busy while its attempt count stood still, and free the moment a ruling landed.
 * That reading is wrong in the one direction that costs a working tree. A
 * ruling is something an agent asks for IN THE MIDDLE of its turn — it runs
 * `verify-fix`, reads the answer, reports, keeps editing — so the ruling lands
 * while the agent is still very much alive. The queue took it as permission to
 * open the next window, and two agents edited one checkout: the second one's
 * first `git status` was full of files the first was mid-edit in.
 *
 * The same reading opened two windows on ONE issue. A ruling that spends an
 * attempt without closing the issue re-hands the head, which is right when the
 * agent has given up and wrong while it is still going; a still-open ruling is
 * the normal middle of a turn, not the end of one.
 *
 * So the handoff script takes a lease before it starts the tool and drops it
 * when the tool exits, and the pump refuses to hand anything over while one is
 * held. The advance condition stops being "lookout has ruled" and becomes "the
 * agent lookout launched has gone", which is the thing the queue actually meant
 * all along.
 *
 * Liveness is the process, not the file. A Terminal that was force-quit never
 * ran its trap, and a lease nobody can release is a queue that never moves
 * again — so a lease whose process is gone is not a lease. That check is also
 * what makes the file safe to leave lying around between runs.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LOOKOUT_DIR } from "../config-locate.js";

/** The handoff that is running, as the handoff script wrote it down. */
export interface Lease {
  /** The issue whose window is open. */
  issue: string;
  /** The handoff script's own pid, which lives as long as the tool does. */
  pid: number;
  startedAt: string;
}

export function leasePath(projectDir: string): string {
  return join(projectDir, LOOKOUT_DIR, "queue-lease.json");
}

function parse(raw: unknown): Lease | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.issue !== "string" || !r.issue.trim()) return null;
  // A pid is the whole point of the record; without one there is nothing to ask
  // about, and treating that as "held" would wedge the queue on a bad write.
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0) return null;
  return {
    issue: r.issue.trim(),
    pid: r.pid,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : new Date(0).toISOString(),
  };
}

/**
 * Whether that process is still there.
 *
 * Signal 0 is the ask-don't-tell of `kill`: it runs every permission and
 * existence check and delivers nothing. EPERM means the process exists and
 * belongs to somebody else, which is still a process, so only ESRCH is gone.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The lease being held right now, or null.
 *
 * A file naming a process that has gone is cleared as it is read: the handoff
 * that wrote it cannot come back to tidy up, and leaving it would mean every
 * later read pays the same syscall to reach the same answer.
 */
export function readLease(projectDir: string): Lease | null {
  const p = leasePath(projectDir);
  if (!existsSync(p)) return null;
  let lease: Lease | null = null;
  try {
    lease = parse(JSON.parse(readFileSync(p, "utf8")) as unknown);
  } catch {
    // An unreadable lease is not a claim on anything. Clearing it is what stops
    // one truncated write from parking the queue forever.
    lease = null;
  }
  if (lease && alive(lease.pid)) return lease;
  clearLease(projectDir);
  return null;
}

/** Whether anything holds the queue. What the pump asks. */
export function leaseHeld(projectDir: string): boolean {
  return readLease(projectDir) !== null;
}

export function clearLease(projectDir: string): void {
  try {
    rmSync(leasePath(projectDir), { force: true });
  } catch {
    // Losing the race to another process's cleanup is the good outcome here.
  }
}

/**
 * The shell that takes the lease, runs the tool, and drops it however it ends.
 *
 * Written as lines for the handoff script to splice in. Three things it must
 * keep, each of which is a queue that stops moving if it slips:
 *
 * 1. **No `exec`.** Replacing the shell with the tool leaves nothing to run the
 *    trap, so the lease outlives the session and its pid stays alive because it
 *    IS the tool's pid.
 * 2. **The trap covers the ways a Terminal really ends**, which is mostly
 *    somebody closing the window: HUP, not just a clean EXIT.
 * 3. **`$$` is the script's own pid**, and the script stays in the foreground
 *    for the whole session, so "the lease's process is alive" and "the agent is
 *    still going" are the same question.
 */
export function leaseScript(projectDir: string, issue: string, command: string): string {
  const lease = leasePath(projectDir);
  return [
    "#!/bin/sh",
    `cd ${JSON.stringify(projectDir)}`,
    `LOOKOUT_LEASE=${JSON.stringify(lease)}`,
    'trap \'rm -f "$LOOKOUT_LEASE"\' EXIT HUP INT TERM',
    `printf '{"issue":"%s","pid":%d,"startedAt":"%s"}\\n' ${JSON.stringify(issue)} "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOOKOUT_LEASE"`,
    command,
    "",
  ].join("\n");
}
