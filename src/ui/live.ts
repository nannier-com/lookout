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
 * What is sent is the whole status payload, the same body `/api/status`
 * answers with, and not a delta. The page already redraws only the regions
 * whose signature moved, so a delta would buy bytes on a loopback socket and
 * cost a second implementation of the fold that `summarise` already is.
 */
import type { Server, ServerWebSocket } from "bun";
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
      for (const ws of [...sockets]) {
        try {
          ws.send(body);
        } catch {
          // A socket that cannot be written to is one the browser has already
          // dropped; the close handler will not always have run yet.
          sockets.delete(ws);
        }
      }
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
 * Keep the connection from being closed for being quiet.
 *
 * Bun drops an idle socket after a couple of minutes, and a board with no run
 * against it is quiet for hours. A ping is invisible to the page: the browser
 * answers it at the protocol level without waking any handler.
 */
const HEARTBEAT_MS = 30_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;

export const live = {
  open(ws: ServerWebSocket<undefined>): void {
    sockets.add(ws);
    // Greet with the board as it stands. A tab that reconnects after a laptop
    // slept has missed every push in between, and asking it to wait for the
    // next disk event would leave it showing yesterday's run. The other tabs
    // get a frame they already had, which is cheaper than the ordering bug the
    // alternative buys.
    void pushNow(true);
    heartbeat ??= setInterval(() => {
      for (const s of sockets) s.ping();
    }, HEARTBEAT_MS);
  },
  close(ws: ServerWebSocket<undefined>): void {
    sockets.delete(ws);
    if (sockets.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
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
