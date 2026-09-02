// The queue: what it keeps, and what moves it along.
//
// The pump is the half worth testing hardest, because two of its three
// properties are invisible when they hold and unbounded loops when they do not:
// it writes only when something changed, and a handoff that could not happen is
// terminal rather than retried. Both are asserted here by counting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceQueue, queueableReason, setHandoff, type Handoff } from "../src/ui/queue-pump.js";
import { loadQueue, queueDigest, queuePath, saveQueue, type QueueItem } from "../src/ui/queue.js";
import { handle } from "../src/ui/routes.js";
import { boardNow, forgetBoard, statusBody } from "../src/ui/payload.js";
import { session, setCurrentProject } from "../src/ui/session.js";
import { tmpProject } from "./tmp-project.js";
import type { BoardEntry } from "../src/report/board-types.js";
import type { ResolvedConfig } from "../src/types.js";
import type { StatusPayload } from "../src/ui/payload.js";

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

/** Only the fields the pump and the queueing rule actually read. */
function entry(id: string, status: string, attempt = 0): BoardEntry {
  return { id, status, attempt } as unknown as BoardEntry;
}

let project: ResolvedConfig;
let opened: string[];
let restore: Handoff;

beforeEach(() => {
  project = tmpProject("lookout-queue-");
  opened = [];
  restore = setHandoff((_r, issue) => {
    opened.push(issue);
    return Promise.resolve({ launched: true });
  });
  session.queue = [];
  session.queueRev = 0;
  session.queueMtime = 0;
  session.running = null;
});

afterEach(() => {
  setHandoff(restore);
  session.queue = [];
  session.running = null;
});

function queued(...ids: string[]): QueueItem[] {
  return ids.map((issue) => ({ issue, tool: "claude-code", queuedAt: "2026-09-02T00:00:00.000Z" }));
}

describe("the queue file", () => {
  test("lives in the project, beside ui.json, and an unwritten one is empty", async () => {
    expect(queuePath(project.projectDir)).toBe(join(project.projectDir, ".lookout", "queue.json"));
    expect(await loadQueue(project.projectDir)).toEqual([]);
  });

  test("round-trips, and drops entries it cannot read rather than the whole queue", async () => {
    await saveQueue(project.projectDir, queued("100001", "100002"));
    expect((await loadQueue(project.projectDir)).map((q) => q.issue)).toEqual(["100001", "100002"]);

    // One entry with no id, one duplicate, one good.
    await Bun.write(
      queuePath(project.projectDir),
      JSON.stringify({ items: [{ tool: "claude-code" }, ...queued("100003", "100003")] }),
    );
    expect((await loadQueue(project.projectDir)).map((q) => q.issue)).toEqual(["100003"]);
  });

  test("a queue nobody can parse loads as empty rather than throwing", async () => {
    await Bun.write(queuePath(project.projectDir), "{ not json");
    expect(await loadQueue(project.projectDir)).toEqual([]);
  });
});

describe("the pump", () => {
  test("hands over the head and leaves everything behind it alone", async () => {
    session.queue = queued("100001", "100002");
    await advanceQueue(project, [entry("100001", "open"), entry("100002", "open")]);
    expect(opened).toEqual(["100001"]);
    expect(session.queue[0]?.handedOffAt).toBeString();
    expect(session.queue[1]?.handedOffAt).toBeUndefined();
  });

  test("hands over once and not again while the attempt count holds", async () => {
    session.queue = queued("100001");
    const board = [entry("100001", "open")];
    await advanceQueue(project, board);
    await advanceQueue(project, board);
    await advanceQueue(project, [entry("100001", "still-open")]);
    expect(opened).toEqual(["100001"]);
  });

  test("hands over again once a ruling has actually spent an attempt", async () => {
    session.queue = queued("100001");
    await advanceQueue(project, [entry("100001", "open", 0)]);
    await advanceQueue(project, [entry("100001", "still-open", 1)]);
    expect(opened).toEqual(["100001", "100001"]);
  });

  for (const status of ["done", "archived", "blocked"]) {
    test(`drops a head lookout has finished with (${status}) and starts the next`, async () => {
      session.queue = queued("100001", "100002");
      await advanceQueue(project, [entry("100001", status), entry("100002", "open")]);
      expect(session.queue.map((q) => q.issue)).toEqual(["100002"]);
      expect(opened).toEqual(["100002"]);
    });
  }

  test("drops a settled issue from the middle too", async () => {
    session.queue = queued("100001", "100002", "100003");
    session.queue[0] = { ...session.queue[0]!, handedOffAt: "2026-09-02T00:00:00.000Z", handedOffAtAttempt: 0 };
    await advanceQueue(project, [
      entry("100001", "open"),
      entry("100002", "done"),
      entry("100003", "open"),
    ]);
    expect(session.queue.map((q) => q.issue)).toEqual(["100001", "100003"]);
  });

  // The loop this guards against: recording the reason is itself a write into
  // the watched directory, so a head that still looked un-handed-off afterwards
  // would be retried by the nudge that write caused, forever.
  test("a handoff that could not happen is recorded once and never retried", async () => {
    setHandoff((_r, issue) => {
      opened.push(issue);
      return Promise.resolve({ launched: false, reason: "claude is not on PATH" });
    });
    session.queue = queued("100001");
    const board = [entry("100001", "open")];
    await advanceQueue(project, board);
    await advanceQueue(project, board);
    await advanceQueue(project, board);
    expect(opened).toEqual(["100001"]);
    expect(session.queue[0]?.failedAt).toBeString();
    expect(session.queue[0]?.lastReason).toBe("claude is not on PATH");
  });

  test("writes nothing when nothing changed", async () => {
    session.queue = queued("100001");
    const board = [entry("100001", "open")];
    await advanceQueue(project, board);
    const after = await Bun.file(queuePath(project.projectDir)).text();
    const rev = session.queueRev;
    await advanceQueue(project, board);
    await advanceQueue(project, board);
    expect(await Bun.file(queuePath(project.projectDir)).text()).toBe(after);
    expect(session.queueRev).toBe(rev);
  });

  test("holds the head while a check is running, rather than photographing a half-edited tree", async () => {
    session.queue = queued("100001");
    session.running = {
      child: { exitCode: null, killed: false } as never,
      project,
      stopping: false,
      kind: "check",
    };
    await advanceQueue(project, [entry("100001", "open")]);
    expect(opened).toEqual([]);
    expect(session.queue[0]?.handedOffAt).toBeUndefined();
  });

  test("a queue written by another process is picked up, not overwritten", async () => {
    session.queue = queued("100001");
    session.queueMtime = 0;
    await saveQueue(project.projectDir, queued("100009"));
    await advanceQueue(project, [entry("100009", "open")]);
    expect(session.queue.map((q) => q.issue)).toEqual(["100009"]);
  });

  test("a board it cannot read does not take the watcher's timer down with it", async () => {
    session.queue = queued("100001");
    setHandoff(() => {
      throw new Error("the handoff exploded");
    });
    await advanceQueue(project, [entry("100001", "open")]);
    expect(session.queue.map((q) => q.issue)).toEqual(["100001"]);
  });

  test("LOOKOUT_NO_HANDOFF advances the queue without opening anything", async () => {
    const was = process.env.LOOKOUT_NO_HANDOFF;
    process.env.LOOKOUT_NO_HANDOFF = "1";
    try {
      session.queue = queued("100001");
      await advanceQueue(project, [entry("100001", "open")]);
      expect(opened).toEqual([]);
      expect(session.queue[0]?.handedOffAt).toBeString();
    } finally {
      if (was === undefined) delete process.env.LOOKOUT_NO_HANDOFF;
      else process.env.LOOKOUT_NO_HANDOFF = was;
    }
  });
});

describe("what may be queued", () => {
  test("an issue with attempts left may be", () => {
    expect(queueableReason(entry("100001", "open", 0), 2)).toBeNull();
    expect(queueableReason(entry("100001", "still-open", 1), 2)).toBeNull();
  });

  // Refused at the door rather than queued and dropped by the pump on its next
  // tick, which from the page looks like a press that did nothing at all.
  test("one lookout has given up on is refused, and the refusal says how to reopen it", () => {
    expect(queueableReason(entry("100001", "blocked", 2), 2)).toContain("backlog set --issue 100001");
    expect(queueableReason(entry("100001", "open", 2), 2)).toContain("out of attempts");
    expect(queueableReason(entry("100001", "done", 0), 2)).toContain("already ruled");
    expect(queueableReason(undefined, 2)).toBe("no issue with that id");
  });
});

describe("the digest", () => {
  test("is what decides whether a save is worth doing", () => {
    const a = queued("100001");
    expect(queueDigest(a)).toBe(queueDigest(queued("100001")));
    expect(queueDigest(a)).not.toBe(queueDigest(queued("100001", "100002")));
  });
});

// The routes, and the one thing the payload's cache has to be told about.
//
// `statusBody` is keyed on a string composed by hand out of the things that
// move, and `queue.json` moves none of them: it is a sibling of the backlog and
// the issues directory, not one of them. So a queue change with nothing else
// happening is exactly the case that would serve a stale page.
describe("the queue over HTTP", () => {
  let id: string;

  beforeEach(async () => {
    writeFileSync(
      join(project.projectDir, ".lookout", "backlog.json"),
      JSON.stringify({
        note: "",
        project: "app",
        updatedAt: new Date(0).toISOString(),
        findings: { f1: finding() },
      }),
    );
    setCurrentProject(project);
    forgetBoard();
    // Ids are minted on load, which is the point of a random id: ask which one
    // this backlog got rather than naming it.
    id = (await boardNow(project))[0]!.id;
    forgetBoard();
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return (await handle(
      new Request("http://127.0.0.1" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      null as never,
    ))!;
  }

  test("a press queues rather than launching, and a second press is not a second entry", async () => {
    const r = await post("/api/queue", { issue: id, tool: "claude-code" });
    expect(r.status).toBe(200);
    // The pump hands the head over on the way out, which is the whole point:
    // one press both queues and starts it when nothing else is in the line.
    expect(opened).toEqual([id]);
    await post("/api/queue", { issue: id, tool: "claude-code" });
    expect(session.queue.filter((q) => q.issue === id)).toHaveLength(1);
    expect(opened).toEqual([id]);
  });

  test("an issue that is not on the board is refused, not queued", async () => {
    const r = await post("/api/queue", { issue: "999999" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("no issue with that id");
    expect(session.queue).toEqual([]);
  });

  test("the X takes one back out", async () => {
    await post("/api/queue", { issue: id });
    const r = await post("/api/queue/remove", { issue: id });
    expect(r.status).toBe(200);
    expect(session.queue).toEqual([]);
  });

  test("a queue change is not served from the cache of the one before it", async () => {
    const before = JSON.parse(await statusBody(project)) as StatusPayload;
    expect(before.status.queue).toEqual([]);
    session.queue = queued("100001");
    session.queueRev++;
    const after = JSON.parse(await statusBody(project)) as StatusPayload;
    expect(after.status.queue.map((q) => q.issue)).toEqual(["100001"]);
  });
});
