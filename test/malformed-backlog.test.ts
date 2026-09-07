/**
 * A backlog nobody can read, and a server that stays up anyway.
 *
 * `backlog.json` is the one durable record lookout keeps about a project, and
 * it is a file: a person edits it, an editor truncates it, a tool writes half
 * the shape. Two separate things have to hold when that happens, and neither
 * covers for the other.
 *
 * A backlog merely MISSING a key it has always had is not corrupt, so it
 * loads. That is the load boundary's job and it reaches well past the page:
 * every verb reads this file, and `Object.values(backlog.findings)` appears at
 * a dozen call sites that all took the key on faith.
 *
 * A backlog nobody can PARSE is corrupt, and still throws on purpose. Reading
 * one as empty would show a project whose every finding had been ruled gone,
 * and the next save would make that true. So the second thing is containment:
 * the paths that reach the board from a timer have to survive the throw
 * instead of taking the process with them. That is the bug this file was
 * written against -- the watcher's callback is a bare async function, its
 * rejection had nowhere to land, and a `lookout ui` that had been up for hours
 * exited the moment a bad backlog appeared underneath it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookoutDir } from "../src/config.js";
import { reconcileIssues } from "../src/issues/registry.js";
import { forgetBoard } from "../src/ui/payload.js";
import { pumpQueue } from "../src/ui/queue-pump.js";
import { session, setCurrentProject } from "../src/ui/session.js";
import { startWatching, stopWatching } from "../src/ui/watch.js";
import { loadBacklog } from "../src/verbs/backlog.js";
import { tmpProject } from "./tmp-project.js";
import type { Backlog } from "../src/backlog/lib.js";
import type { ResolvedConfig } from "../src/types.js";

/** One open finding, enough for the backlog to mint an issue around. */
function finding(): unknown {
  return {
    fingerprint: "f1",
    target: "app",
    route: "/dash",
    state: "rest",
    platform: "web",
    formFactor: "phone",
    scheme: "dark",
    category: "layout-overflow",
    attribute: "overlap",
    severity: "high",
    status: "open",
    reason: null,
    title: "Header icons collide with the activity row",
    problem: "A badge sits on top of the heading.",
    expected: "The heading should be legible.",
    observed: "Two icons overlap the section header.",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [{ shotId: "s1", path: "a.png", hash: "h1", runId: "r1" }],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
  };
}

let project: ResolvedConfig;

/** Put `backlog.json` in whatever state the test at hand is about. */
function writeBacklog(body: string): void {
  writeFileSync(join(lookoutDir(project), "backlog.json"), body);
}

beforeEach(() => {
  project = tmpProject("lookout-malformed-");
  // The pump reads all four, and every one of them outlives a test file.
  session.queue = [];
  session.queueRev = 0;
  session.queueMtime = 0;
  session.running = null;
  forgetBoard();
});

afterEach(() => {
  session.queue = [];
  session.running = null;
});

describe("a backlog missing a key it has always had", () => {
  test("reconciles rather than dereferencing the key that is not there", () => {
    // The reported crash, one frame down: `issues` was defaulted a line above
    // the loop and `findings` was not.
    const backlog = { issues: {} } as unknown as Backlog;
    expect(reconcileIssues(backlog, "2026-09-07T00:00:00.000Z")).toEqual([]);
    expect(backlog.findings).toEqual({});
  });

  test("loads, with both containers in the shape the type promises", async () => {
    // Verbatim the file that took the server down: valid JSON, no `findings`,
    // and an `issues` that is an array where a record was promised.
    writeBacklog('{"issues":[{"id":"ISSUE-1"}]}');
    const backlog = await loadBacklog(project);
    expect(backlog.findings).toEqual({});
    // A record, not the array that was on disk. An id minted onto an array is
    // a string key, and `JSON.stringify` drops those: the save meant to
    // remember the number would have been what forgot it.
    expect(Array.isArray(backlog.issues)).toBe(false);
    expect(backlog.issues).toEqual({});
  });

  test("keeps the findings when it is `issues` that is missing", async () => {
    // Normalizing must not be a euphemism for emptying. This is the shape a
    // backlog written before ids existed has, and its findings are the record.
    writeBacklog(JSON.stringify({ findings: { f1: finding() } }));
    const backlog = await loadBacklog(project);
    expect(Object.keys(backlog.findings)).toEqual(["f1"]);
    // One finding is one root cause, and reconciling on load is what gives it
    // the number its folder is named after.
    expect(Object.values(backlog.issues)).toHaveLength(1);
  });
});

describe("a backlog nobody can parse", () => {
  test("still throws, rather than reading as a project with nothing wrong", async () => {
    writeBacklog("{ not json");
    expect(loadBacklog(project)).rejects.toThrow();
  });

  test("does not come back out of the pump, which two callers do not await", async () => {
    // `verbs/ui.ts` pumps once at startup and `ui/watch.ts` pumps on every
    // write, both with a bare `void`. A rejection from either is an unhandled
    // one, and the board build that throws sits in this function's argument
    // list, outside the catch that `advanceQueue` already had.
    writeBacklog("{ not json");
    setCurrentProject(project);
    expect(await pumpQueue(project)).toBeUndefined();
  });

  test("does not reach the event loop from the watcher's callback", async () => {
    writeBacklog("{ not json");
    // Driven through a project change rather than a file event: the watcher
    // arms and nudges on both, and only one of them is a promise about how
    // quickly the operating system reports a write.
    startWatching();
    try {
      setCurrentProject(project);
      // Past the watcher's coalescing window, and then some.
      await Bun.sleep(400);
      // Reaching here at all is most of the assertion: an escaped rejection
      // fails this test where it is thrown, before anything below runs. What
      // is left to check is that the watcher held its ground rather than
      // quietly unwinding, so the next write is still pumped.
      expect(await pumpQueue(project)).toBeUndefined();
    } finally {
      stopWatching();
    }
  });
});
