/**
 * The page is told, rather than asking.
 *
 * This is the one test in the suite that stands the whole server up: the router
 * answers `Response` objects on a Bun server now, and one of its routes stops
 * being a request and becomes a socket. Neither of those is exercised by
 * testing the modules underneath, and the failure they can produce is total,
 * a page that renders once and then never moves again, so it is worth the
 * fifty lines of setup.
 *
 * What is asserted is the contract the page depends on: a socket is greeted
 * with the board as it stands, a run appending to the log reaches it without
 * anybody asking, and a disk that moved without changing the answer does not.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { evidenceDir, lookoutDir } from "../src/config.js";
import { eventsPath } from "../src/report/events.js";
import { live } from "../src/ui/live.js";
import { handle } from "../src/ui/routes.js";
import { setCurrentProject } from "../src/ui/session.js";
import { startWatching, stopWatching, watching } from "../src/ui/watch.js";
import { tmpProject } from "./tmp-project.js";
import { narrationPath } from "../src/report/narration.js";
import type { NarrationFrame } from "../src/ui/narration.js";
import type { StatusPayload } from "../src/ui/payload.js";

const project = tmpProject("lookout-live-");
mkdirSync(evidenceDir(project), { recursive: true });
writeFileSync(eventsPath(project), "");
setCurrentProject(project);
startWatching();

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req, self) => handle(req, self),
  websocket: live,
});
const origin = `127.0.0.1:${server.port}`;

afterAll(() => {
  stopWatching();
  void server.stop(true);
});

/** Wait for something to become true, or give up. Watchers are not instant. */
async function until(ok: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await Bun.sleep(20);
  }
  return ok();
}

/** Every frame the server has written down one socket, sorted by kind. */
type Frame =
  | { kind: "status"; body: StatusPayload }
  | { kind: "narration"; body: NarrationFrame };

/** A page: one socket, and everything the server has said down it. */
async function openPage(): Promise<{
  sent: StatusPayload[];
  said: NarrationFrame[];
  close: () => void;
}> {
  const sent: StatusPayload[] = [];
  const said: NarrationFrame[] = [];
  const ws = new WebSocket(`ws://${origin}/api/live`);
  ws.onmessage = (e: MessageEvent<string>) => {
    const frame = JSON.parse(e.data) as Frame;
    if (frame.kind === "status") sent.push(frame.body);
    else said.push(frame.body);
  };
  await until(() => ws.readyState === WebSocket.OPEN);
  return { sent, said, close: () => ws.close() };
}

describe("the live channel", () => {
  test("greets a page with the board as it stands", async () => {
    const page = await openPage();
    expect(await until(() => page.sent.length >= 1)).toBe(true);
    expect(page.sent[0]!.projectDir).toBe(project.projectDir);
    page.close();
  });

  test("pushes what a run appends to the log, unasked", async () => {
    const page = await openPage();
    await until(() => page.sent.length >= 1);
    appendFileSync(
      eventsPath(project),
      JSON.stringify({ at: new Date().toISOString(), runId: "r1", kind: "phase", message: "judging" }) + "\n",
    );
    expect(await until(() => page.sent.length >= 2)).toBe(true);
    expect(page.sent[page.sent.length - 1]!.status.phase).toBe("judging");
    page.close();
  });

  test("says nothing when the disk moved but the answer did not", async () => {
    const page = await openPage();
    await until(() => page.sent.length >= 1);
    const before = page.sent.length;
    // A touched file invalidates the server's cache, which is exactly the case
    // worth checking: rebuilding the payload must not mean sending it.
    const now = new Date();
    utimesSync(eventsPath(project), now, now);
    await Bun.sleep(600);
    expect(page.sent.length).toBe(before);
    page.close();
  });

  test("greets a second page even when nothing has changed", async () => {
    // The push that follows a change is skipped when the body matches what was
    // last sent, and a tab opening into that state would otherwise be handed
    // nothing at all and render an empty board until something moved.
    const first = await openPage();
    await until(() => first.sent.length >= 1);
    const second = await openPage();
    expect(await until(() => second.sent.length >= 1)).toBe(true);
    expect(second.sent[0]!.projectDir).toBe(project.projectDir);
    first.close();
    second.close();
  });

  test("a judge speaking reaches the page without the board being rebuilt", async () => {
    const page = await openPage();
    await until(() => page.sent.length >= 1);
    const boards = page.sent.length;
    appendFileSync(
      narrationPath(project),
      JSON.stringify({
        at: new Date().toISOString(),
        runId: "r1",
        panel: "judge-geometry",
        call: "c1",
        kind: "text",
        text: "the second card sits lower than its row",
      }) + "\n",
    );
    expect(await until(() => page.said.length >= 1)).toBe(true);
    expect(page.said[page.said.length - 1]!.lines[0]!.text).toContain("sits lower");
    // The board said nothing, which is the point: narration moves many times a
    // second and rebuilding the board for each one is what this avoids.
    expect(page.sent.length).toBe(boards);
    page.close();
  });

  test("a second page is handed the transcript so far, not just what comes next", async () => {
    const page = await openPage();
    expect(await until(() => page.said.length >= 1)).toBe(true);
    expect(page.said[0]!.reset).toBe(true);
    expect(page.said[0]!.lines.length).toBeGreaterThan(0);
    page.close();
  });

  test("refuses a plain request to the socket's own route", async () => {
    const res = await fetch(`http://${origin}/api/live`);
    expect(res.status).toBe(400);
  });
});

describe("the server underneath it", () => {
  test("still answers the status the page boots from", async () => {
    const res = await fetch(`http://${origin}/api/status`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StatusPayload).projectDir).toBe(project.projectDir);
  });

  test("watches both places a run writes", () => {
    expect(watching()).toContain(evidenceDir(project));
    expect(watching()).toContain(lookoutDir(project));
  });
});
