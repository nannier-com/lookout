/**
 * The socket the page holds open, and what gets written down it.
 *
 * The page used to ask `/api/status` every 1.5 seconds, which is a poor fit for
 * what it is watching: a `check` says nothing for a minute at a time and then
 * files a finding, so the poll was both too slow to be live and too frequent to
 * be idle. This is the other way round. The page opens one socket, the server
 * writes to it when something actually moves, and a board nobody is running
 * anything against costs no traffic at all.
 *
 * One direction only. Every write the page makes is already a POST, and it
 * should stay one: those are actions with answers, and an action whose outcome
 * arrives on a different channel than the request is harder to reason about
 * than one that simply returns it.
 *
 * Frames carry a kind, because there are two things to say. A `status` frame is
 * the whole payload `/api/status` answers with rather than a delta: the page
 * already redraws only the regions whose signature moved, so a delta would buy
 * bytes on a loopback socket and cost a second implementation of the fold that
 * `summarise` already is. A `narration` frame IS a delta, for the opposite
 * reason: a judge writing a verdict says something several times a second, and
 * re-sending its whole transcript each time would put the same thousand lines
 * on the wire over and over.
 */
import type { Server, ServerWebSocket } from "bun";
import { newNarration } from "./narration.js";
import { readNarration } from "../report/narration.js";
import { statusBody } from "./payload.js";
import { currentProjectOrNull } from "./session.js";

/** Every page with this server open. Usually one; a second tab is a second entry. */
const sockets = new Set<ServerWebSocket<undefined>>();

/**
 * The body every open socket has already been given.
 *
 * The disk moves far more often than the answer does: a capture writes a dozen
 * files per shot and the payload it produces is identical until a finding
 * lands. Comparing before sending is what keeps a run from pushing the same
 * board fifty times.
 */
let lastSent = "";

/** Upgrade a request into a live socket. False when it was not a websocket request. */
export function openLive(req: Request, server: Server<undefined>): boolean {
  return server.upgrade(req);
}

/**
 * A push already under way.
 *
 * Building the payload reads the backlog and every cluster's state file, and
 * the watcher can fire again while that is happening. Without this, a burst of
 * appends would start a dozen overlapping builds and deliver them out of order.
 */
let pushing = false;
let pendingPush = false;
let pendingForce = false;

/**
 * Send the current status to every open socket.
 *
 * Called by the watcher when the run log or the backlog moves, by the few
 * transitions no file records (a run starting, a child dying), and by a socket
 * opening, which forces a send because a page that has just connected has
 * nothing on it yet.
 *
 * Forcing goes through here rather than being a send of its own so that both
 * kinds of push are ordered against each other. A greeting built beside this
 * could be delivered after a newer payload and leave that tab stale until
 * something else happened to move.
 */
export async function pushNow(force = false): Promise<void> {
  if (sockets.size === 0) return;
  if (pushing) {
    pendingPush = true;
    pendingForce ||= force;
    return;
  }
  pushing = true;
  try {
    const body = await snapshot();
    if (body !== null && (force || body !== lastSent)) {
      lastSent = body;
      // Wrapped at the last moment so the comparison above, and the cache the
      // body came from, both stay about the board itself.
      broadcast(`{"kind":"status","body":${body}}`);
    }
  } finally {
    pushing = false;
    if (pendingPush) {
      pendingPush = false;
      const again = pendingForce;
      pendingForce = false;
      void pushNow(again);
    }
  }
}

/** The status body, or null when there is nothing to serve or it could not be built. */
async function snapshot(): Promise<string | null> {
  const project = currentProjectOrNull();
  if (!project) return null;
  try {
    return await statusBody(project);
  } catch {
    // A malformed backlog must not take the socket down, the same way it does
    // not take the page down over HTTP.
    return null;
  }
}

/**
 * Write one frame to every page.
 *
 * Frames carry a kind because there is more than one thing to say now: the
 * board, and what the judge is saying while it decides what goes on it. They
 * travel on the same socket because they describe the same run, and separating
 * them would make a page hold two connections to say so.
 */
function broadcast(frame: string): void {
  for (const ws of [...sockets]) {
    try {
      ws.send(frame);
    } catch {
      // A socket that cannot be written to is one the browser has already
      // dropped; the close handler will not always have run yet.
      sockets.delete(ws);
    }
  }
}

/**
 * Push whatever the judges have said since the last time.
 *
 * Separate from the board's push, and not folded into it, because the two move
 * at completely different rates: a verdict being written says something several
 * times a second while the board it will land on does not change at all. A push
 * that carried both would either rebuild the board per token or hold the
 * narration back until a finding landed.
 */
export function pushNarration(): void {
  if (sockets.size === 0) return;
  const project = currentProjectOrNull();
  if (!project) return;
  const frame = newNarration(project);
  if (!frame) return;
  broadcast(`{"kind":"narration","body":${JSON.stringify(frame)}}`);
}

/**
 * Hand one page the run's narration as it stands.
 *
 * Sent to that socket alone, and without touching the shared cursor: a second
 * tab opening must not make the first one throw away what it is showing and
 * receive it all again.
 */
function greetNarration(ws: ServerWebSocket<undefined>): void {
  const project = currentProjectOrNull();
  if (!project) return;
  const lines = readNarration(project, GREETING_LINES);
  if (lines.length === 0) return;
  try {
    ws.send(`{"kind":"narration","body":${JSON.stringify({ reset: true, lines })}}`);
  } catch {
    sockets.delete(ws);
  }
}

/** How much of a run in progress a page that arrives late is shown. */
const GREETING_LINES = 400;

/*
 * Nothing here keeps the connection alive, and nothing needs to.
 *
 * There was a thirty-second ping in this file, on the stated grounds that Bun
 * reaps an idle socket after a couple of minutes and a board with no run
 * against it is quiet for hours. The first half is wrong: `sendPings` defaults
 * to true, so the server already pings and answers pings for us. Measured on
 * 2026-09-01 against bun 1.3.14, a silent socket survived 150 seconds with no
 * ping of ours, and survived 26 seconds against an explicit
 * `websocket: { idleTimeout: 8 }`, which is the one that governs a socket. The
 * interval was a timer and a lifecycle to get wrong in exchange for a job the
 * server was already doing.
 */

export const live = {
  open(ws: ServerWebSocket<undefined>): void {
    sockets.add(ws);
    // Greet with the board as it stands. A tab that reconnects after a laptop
    // slept has missed every push in between, and asking it to wait for the
    // next disk event would leave it showing yesterday's run. The other tabs
    // get a frame they already had, which is cheaper than the ordering bug the
    // alternative buys.
    void pushNow(true);
    // Anything said but not yet broadcast goes out first, so the cursor is at
    // the end of the file before this tab is greeted. Without that ordering the
    // greeting and the next incremental push both carry the same lines, and the
    // new tab renders the transcript twice.
    pushNarration();
    // Then the run's narration as it stands: a tab that has just connected has
    // nothing on it, so it is given the tail rather than only what happens to
    // be said next. Its reset replaces whatever the push above put there.
    greetNarration(ws);
  },
  close(ws: ServerWebSocket<undefined>): void {
    sockets.delete(ws);
  },
  /**
   * The page never sends anything. Its writes are POSTs, deliberately, so this
   * exists only because a websocket handler must have one.
   */
  message(): void {},
};

/** How many pages are listening. Exported for the watcher, which sleeps when nobody is. */
export function liveCount(): number {
  return sockets.size;
}
