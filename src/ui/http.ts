/**
 * The small manners of an HTTP server, in one place.
 *
 * Replying with JSON and reading a JSON body are two lines each, which is
 * exactly why they were written inline four times over and drifted: one route
 * capped the body it would read and another did not. A handler should say what
 * it means and not how a response is spelled.
 *
 * The server answers with `Response` objects now rather than writing into a
 * `ServerResponse`, because it is a `Bun.serve` server: the page holds a socket
 * open and a request handler that returns a value composes with an upgrade in a
 * way one that writes into a stream does not.
 */
export const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function json(code: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Plain text, for the answers a person reads in a browser tab rather than parses. */
export function text(code: number, body: string): Response {
  return new Response(body, {
    status: code,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * The cap on a request body.
 *
 * Every write this server accepts is a few dozen bytes of JSON naming an issue
 * or a directory. The cap is the whole of the defence against a stray POST
 * filling memory, and it is one number now rather than the three that had
 * drifted apart across the routes.
 */
const MAX_BODY = 8192;

/**
 * Read a JSON request body, capped.
 *
 * Read through the stream rather than `req.json()` so the cap holds for a body
 * that arrives chunked with no content-length: a client that says nothing about
 * its size is exactly the one worth capping.
 */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = req.body;
  if (!body) return {};
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return {};
      }
      chunks.push(value);
    }
    const raw = new TextDecoder().decode(Buffer.concat(chunks));
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    // A body that is not JSON is the same answer as one that was not sent: the
    // handler reads the fields it needs and refuses when they are missing.
    return {};
  }
}

/**
 * Whether a request came from the page this server itself serves.
 *
 * This exists for the live socket. A websocket handshake is not subject to the
 * same-origin policy and needs no preflight, so any page in any tab can open
 * `ws://127.0.0.1:7333/api/live`, and this server speaks first: it greets a new
 * socket with the board and the judge's transcript before the other end says
 * anything. Measured on 2026-09-01, a handshake carrying
 * `Origin: http://evil.example` was answered `101 Switching Protocols` and
 * handed two kilobytes naming the project's absolute path and every issue on
 * it. The HTTP routes never had this exposure: they send no
 * `Access-Control-Allow-Origin`, so a foreign page cannot read their answers,
 * and Chrome blocks a cross-site POST to a loopback address outright.
 *
 * `Origin` is set by the browser and cannot be forged from page JavaScript, and
 * `Host` is set from the address actually being connected to, so comparing them
 * is exactly the question "was the page that opened this served from here".
 *
 * A request with no `Origin` at all is not a browser: curl, a test, another
 * local process. Those are allowed, because anything that can open a loopback
 * socket on this machine can already read the files this server is reading.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    // An Origin that is not a URL is not one this server handed out.
    return false;
  }
}
