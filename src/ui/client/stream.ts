/**
 * The socket the page keeps open, and what it does when it drops.
 *
 * The page used to ask the server for the board every 1.5 seconds whether
 * anything had happened or not. Now the server says so. What is left on this
 * side is the part a socket cannot do for itself: reconnect.
 *
 * A browser closes a websocket for reasons that have nothing to do with the
 * server being gone, a sleeping laptop chief among them, so a close is not
 * news and must not be reported as one. It is retried, with a backoff that
 * gives up nothing: a page left open overnight against a server that was
 * restarted in the morning finds it again within a few seconds.
 */
import type { NarrationFrame } from "../narration.js";
import type { StatusPayload } from "../payload.js";

/** How long to wait before the first retry, and the ceiling it doubles towards. */
const FIRST_RETRY_MS = 400;
const MAX_RETRY_MS = 8000;

let socket: WebSocket | null = null;
let retry = FIRST_RETRY_MS;

/** Whether the page is currently being pushed to. The fallback poll asks this. */
export function connected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/** What arrives down the socket: the board, or what a judge is saying about it. */
type Frame =
  | { kind: "status"; body: StatusPayload }
  | { kind: "narration"; body: NarrationFrame };

/** Where each kind of frame goes. */
export interface Handlers {
  status: (d: StatusPayload) => void;
  narration: (f: NarrationFrame) => void;
}

/**
 * Open the channel, and keep it open.
 *
 * The handlers are given every frame the server pushes, including the ones sent
 * the moment the socket opens: a tab that reconnects has missed everything that
 * happened while it was away, so the server greets it with the board as it
 * stands, and with the run's narration as it stands, rather than leaving both
 * stale until the next thing moves.
 */
export function listen(on: Handlers): void {
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live";
  let s: WebSocket;
  try {
    s = new WebSocket(url);
  } catch {
    // A browser that refuses to open one at all: the fallback poll covers the
    // page, and this keeps trying.
    setTimeout(() => listen(on), retry);
    retry = Math.min(retry * 2, MAX_RETRY_MS);
    return;
  }
  socket = s;
  s.onopen = () => {
    retry = FIRST_RETRY_MS;
  };
  s.onmessage = (e: MessageEvent<string>) => {
    try {
      const frame = JSON.parse(e.data) as Frame;
      if (frame.kind === "status") on.status(frame.body);
      else if (frame.kind === "narration") on.narration(frame.body);
    } catch {
      // A frame that is not one of ours is not worth taking the page down for.
    }
  };
  s.onclose = () => {
    if (socket === s) socket = null;
    setTimeout(() => listen(on), retry);
    retry = Math.min(retry * 2, MAX_RETRY_MS);
  };
  // An error is always followed by a close, which is where the retry lives.
  s.onerror = () => s.close();
}
