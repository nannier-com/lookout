/**
 * Who is allowed to open the page's socket.
 *
 * A websocket handshake is not subject to the same-origin policy and needs no
 * preflight, so any page in any tab can open one against a loopback port. This
 * server speaks first: it greets a new socket with the board and the judge's
 * transcript before the other end has said anything. That makes the handshake,
 * and not any later message, the moment the decision has to be made.
 *
 * The HTTP routes are not exposed the same way and are deliberately left alone:
 * they send no `Access-Control-Allow-Origin`, so a foreign page cannot read
 * their answers, and a browser refuses a cross-site request to a loopback
 * address before it is sent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { evidenceDir } from "../src/config.js";
import { eventsPath } from "../src/report/events.js";
import { sameOrigin } from "../src/ui/http.js";
import { live } from "../src/ui/live.js";
import { handle } from "../src/ui/routes.js";
import { setCurrentProject } from "../src/ui/session.js";
import { tmpProject } from "./tmp-project.js";

const project = tmpProject("lookout-origin-");
mkdirSync(evidenceDir(project), { recursive: true });
writeFileSync(eventsPath(project), "");
setCurrentProject(project);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req, self) => handle(req, self),
  websocket: live,
});
const origin = `127.0.0.1:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

/** A handshake the way a browser spells one, with whatever Origin is given. */
function handshake(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://${origin}/api/live`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
      "sec-websocket-version": "13",
      ...headers,
    },
  });
}

describe("deciding whose socket to open", () => {
  test("refuses a page served from somewhere else", async () => {
    const res = await handshake({ origin: "http://evil.example" });
    expect(res.status).toBe(403);
    // The refusal must come before the upgrade: after it, the greeting has
    // already gone out and refusing is too late to matter.
    expect(await res.text()).toContain("origin");
  });

  test("refuses an Origin that is not a URL at all", async () => {
    expect((await handshake({ origin: "null" })).status).toBe(403);
    expect((await handshake({ origin: "%%%" })).status).toBe(403);
  });

  test("lets a real page through, and it is greeted", async () => {
    const sent: string[] = [];
    const ws = new WebSocket(`ws://${origin}/api/live`);
    ws.onmessage = (e: MessageEvent<string>) => sent.push(String(e.data));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && sent.length === 0) await Bun.sleep(20);
    expect(sent.length).toBeGreaterThan(0);
    ws.close();
  });
});

describe("what counts as the same origin", () => {
  const asked = (headers: Record<string, string>): Request =>
    new Request("http://127.0.0.1:7333/api/live", { headers });

  test("the page this server served", () => {
    expect(sameOrigin(asked({ origin: "http://127.0.0.1:7333", host: "127.0.0.1:7333" }))).toBe(true);
  });

  test("a page on another port of the same machine is still somebody else", () => {
    // Another local app is not this one. It can open a loopback socket, but it
    // has no more business reading this board than a remote page does.
    expect(sameOrigin(asked({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:7333" }))).toBe(false);
  });

  test("a request with no Origin is not a browser, and is allowed", () => {
    // curl, a test, the CLI. Anything that can open a loopback socket here can
    // already read the files this server reads.
    expect(sameOrigin(asked({ host: "127.0.0.1:7333" }))).toBe(true);
  });
});
