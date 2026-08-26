// The board: folding one event log, written by several processes, into "who is
// working which cluster, and what are they looking at".
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog,
  eventsPath,
  readEvents,
  summarise,
  type EventKind,
  type LookoutEvent,
} from "../src/report/events.js";
import type { ResolvedConfig } from "../src/types.js";

let clock = 0;
/** Monotonic timestamps, so ordering in a test reads the way it is written. */
function at(): string {
  clock += 1000;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + clock).toISOString();
}

function ev(
  runId: string,
  kind: EventKind,
  message: string,
  data?: Record<string, unknown>,
): LookoutEvent {
  return { at: at(), runId, kind, message, ...(data ? { data } : {}) };
}

function shot(route: string, formFactor: string, scheme: string) {
  return { path: `web/app${route}/rest--${formFactor}-${scheme}.png`, route, formFactor, scheme };
}

/** The events one `check --auto` writes: two shots, then one cluster dispatched. */
function checkRun(): LookoutEvent[] {
  return [
    ev("check-1", "run-start", "lookout check --auto", { project: "app" }),
    ev("check-1", "shot", "app/dash desktop dark", shot("/dash", "desktop", "dark")),
    ev("check-1", "shot", "app/dash phone dark", shot("/dash", "phone", "dark")),
    ev("check-1", "finding", "a11y/contrast: too faint", { severity: "high" }),
    ev("check-1", "dispatch", "dispatch app--a11y--contrast", {
      id: "app--a11y--contrast",
      label: "fix a11y/contrast on /dash",
      brief: "/repo/.lookout/evidence/fix/app--a11y--contrast.md",
      sheet: "/repo/.lookout/evidence/fix/app--a11y--contrast.sheet.png",
      routes: ["/dash"],
      severity: "high",
      category: "a11y",
      shots: [shot("/dash", "desktop", "dark"), shot("/dash", "phone", "dark")],
      shotCount: 2,
      amended: false,
    }),
    ev("check-1", "run-end", "1 finding(s)", { findings: 1 }),
  ];
}

describe("a dispatched cluster carries its own evidence", () => {
  test("the card knows which screenshots the defect was filed against", () => {
    const s = summarise(checkRun());
    expect(s.board).toHaveLength(1);
    const b = s.board[0]!;
    // The whole complaint about the old page: a dozen cards that knew only a
    // count, and one undifferentiated grid of every capture in the run.
    expect(b.shots.map((x) => x.formFactor)).toEqual(["desktop", "phone"]);
    expect(b.sheet).toBe("/repo/.lookout/evidence/fix/app--a11y--contrast.sheet.png");
    expect(b.status).toBe("queued");
    expect(b.agent).toBeNull();
  });

  test("a screenshot listed twice on one cluster is one tile", () => {
    const events = checkRun();
    const dispatch = events[4]!;
    dispatch.data!.shots = [
      shot("/dash", "desktop", "dark"),
      shot("/dash", "desktop", "dark"),
      shot("/dash", "phone", "dark"),
    ];
    expect(summarise(events).board[0]!.shots).toHaveLength(2);
  });
});

describe("a fix session's stint is visible while it runs", () => {
  test("queued, then working, then reported, then ruled", () => {
    const events = checkRun();
    const seen: string[] = [];
    seen.push(summarise(events).board[0]!.status);

    events.push(
      ev("agent-1", "run-start", "agent start app--a11y--contrast", {
        cluster: "app--a11y--contrast",
      }),
      ev("agent-1", "agent-start", "contrast fixer started", {
        cluster: "app--a11y--contrast",
        name: "fix a11y/contrast on /dash",
      }),
    );
    const working = summarise(events);
    seen.push(working.board[0]!.status);
    expect(working.board[0]!.agent?.name).toBe("fix a11y/contrast on /dash");
    expect(working.agents.working).toBe(1);

    events.push(
      ev("agent-2", "run-start", "agent note", { cluster: "app--a11y--contrast" }),
      ev("agent-2", "agent-note", "raised the token to #333", {
        cluster: "app--a11y--contrast",
      }),
    );
    const noted = summarise(events);
    expect(noted.board[0]!.agent?.notes.map((n) => n.text)).toEqual(["raised the token to #333"]);
    // A note is a heartbeat: it moves last-seen without moving start.
    expect(noted.board[0]!.agent!.lastSeenAt > noted.board[0]!.agent!.startedAt).toBe(true);

    events.push(
      ev("agent-3", "run-start", "agent done", { cluster: "app--a11y--contrast" }),
      ev("agent-3", "agent-done", "contrast fixer reported back", {
        cluster: "app--a11y--contrast",
        name: "fix a11y/contrast on /dash",
        commit: "abc1234",
        note: "the token was never applied to the dark palette",
      }),
    );
    const reported = summarise(events);
    seen.push(reported.board[0]!.status);
    expect(reported.board[0]!.agent?.commit).toBe("abc1234");
    expect(reported.board[0]!.agent?.finishedAt).not.toBeNull();
    expect(reported.agents.reported).toBe(1);

    events.push(
      ev("verify-1", "run-start", "lookout verify-fix app--a11y--contrast", {
        cluster: "app--a11y--contrast",
        verb: "verify-fix",
      }),
    );
    seen.push(summarise(events).board[0]!.status);

    events.push(
      ev("verify-1", "shot", "app/dash desktop dark", shot("/dash", "desktop", "dark")),
      ev("verify-1", "verdict", "app--a11y--contrast: passed (attempt 1 of 2)", {
        cluster: "app--a11y--contrast",
        verdict: "passed",
        attempt: 1,
      }),
      ev("verify-1", "run-end", "app--a11y--contrast: passed", { verdict: "passed" }),
    );
    const done = summarise(events);
    seen.push(done.board[0]!.status);

    expect(seen).toEqual(["queued", "working", "reported", "verifying", "passed"]);
    expect(done.agents.resolved).toBe(1);
    // The session's own history survives the ruling; a passed card still says
    // who fixed it and how long it took.
    expect(done.board[0]!.agent?.name).toBe("fix a11y/contrast on /dash");
    expect(done.board[0]!.attempt).toBe(1);
  });

  test("reports naming a cluster nobody dispatched are ignored, not invented", () => {
    const events = checkRun();
    events.push(
      ev("agent-1", "run-start", "agent start", { cluster: "app--typo--nonexistent" }),
      ev("agent-1", "agent-start", "started", { cluster: "app--typo--nonexistent", name: "x" }),
      // A bare note against a cluster with no open stint: nothing to attach it
      // to, and nothing that should throw.
      ev("agent-1", "agent-note", "halfway", { cluster: "app--a11y--contrast" }),
    );
    const s = summarise(events);
    expect(s.board.map((b) => b.id)).toEqual(["app--a11y--contrast"]);
    expect(s.board[0]!.status).toBe("queued");
    expect(s.board[0]!.agent).toBeNull();
  });

  test("a heartbeat does not read as lookout ruling on the fix", () => {
    // `agent` and `verify-fix` both open a run naming one cluster. Treating
    // either as a re-judge put a card that an agent had merely checked in on
    // into "verifying", which claims lookout was looking when it was not.
    const events = checkRun();
    events.push(
      ev("agent-1", "run-start", "agent start", { cluster: "app--a11y--contrast", verb: "agent" }),
      ev("agent-1", "agent-start", "started", {
        cluster: "app--a11y--contrast",
        name: "contrast fixer",
      }),
      ev("agent-2", "run-start", "agent note", { cluster: "app--a11y--contrast", verb: "agent" }),
      ev("agent-2", "agent-note", "halfway", { cluster: "app--a11y--contrast" }),
    );
    expect(summarise(events).board[0]!.status).toBe("working");
  });

  test("a harness that never reports leaves the card queued rather than guessing", () => {
    const s = summarise(checkRun());
    expect(s.board[0]!.status).toBe("queued");
    expect(s.agents).toEqual({ queued: 1, working: 0, reported: 0, resolved: 0 });
  });
});

describe("a re-check attaches to the cluster it re-checked", () => {
  test("its screenshots become the card's after, not the run's headline count", () => {
    const events = checkRun();
    events.push(
      ev("verify-1", "run-start", "lookout verify-fix app--a11y--contrast", {
        cluster: "app--a11y--contrast",
        verb: "verify-fix",
      }),
      ev("verify-1", "shot", "app/dash desktop dark", shot("/dash", "desktop", "dark")),
      ev("verify-1", "shot", "app/dash phone dark", shot("/dash", "phone", "dark")),
      ev("verify-1", "verdict", "still-open", {
        cluster: "app--a11y--contrast",
        verdict: "still-open",
        attempt: 1,
        judgeNote: "the phone capture is still 2.9:1",
      }),
    );
    const s = summarise(events);
    // Two captures in the check, two more in the re-check. The headline counts
    // describe the run that defined the board, so it stays 2, not 4.
    expect(s.shots).toBe(2);
    expect(s.board[0]!.recheck).toHaveLength(2);
    expect(s.board[0]!.shots).toHaveLength(2);
    expect(s.board[0]!.status).toBe("still-open");
    expect(s.board[0]!.judgeNote).toBe("the phone capture is still 2.9:1");
  });

  test("a second re-check replaces the previous after, rather than piling up", () => {
    const events = checkRun();
    for (const n of [1, 2]) {
      events.push(
        ev(`verify-${n}`, "run-start", "lookout verify-fix", {
          cluster: "app--a11y--contrast",
          verb: "verify-fix",
        }),
        ev(`verify-${n}`, "shot", "app/dash desktop dark", shot("/dash", "desktop", "dark")),
      );
    }
    expect(summarise(events).board[0]!.recheck).toHaveLength(1);
  });
});

describe("an amendment puts the cluster back in the queue", () => {
  test("because the session already running never saw the added routes", () => {
    const events = checkRun();
    events.push(
      ev("agent-1", "run-start", "agent start", { cluster: "app--a11y--contrast" }),
      ev("agent-1", "agent-start", "started", {
        cluster: "app--a11y--contrast",
        name: "fix a11y/contrast on /dash",
      }),
      ev("check-1", "dispatch", "amended app--a11y--contrast", {
        id: "app--a11y--contrast",
        label: "fix a11y/contrast on /dash /settings",
        brief: "/repo/.lookout/evidence/fix/app--a11y--contrast.md",
        routes: ["/dash", "/settings"],
        severity: "high",
        category: "a11y",
        shots: [shot("/dash", "desktop", "dark"), shot("/settings", "desktop", "dark")],
        amended: true,
      }),
    );
    const b = summarise(events).board[0]!;
    expect(b.status).toBe("queued");
    expect(b.amended).toBe(true);
    expect(b.agent).toBeNull();
    expect(b.routes).toEqual(["/dash", "/settings"]);
  });
});

describe("the board is ordered by what needs attention", () => {
  test("live work first, settled work last", () => {
    const events = checkRun();
    for (const id of ["b-queued", "c-working", "d-passed"]) {
      events.push(
        ev("check-1", "dispatch", `dispatch ${id}`, {
          id,
          label: id,
          brief: `/repo/${id}.md`,
          routes: ["/x"],
          severity: "low",
          category: "a11y",
          shots: [],
        }),
      );
    }
    events.push(
      ev("agent-1", "run-start", "agent start", { cluster: "c-working" }),
      ev("agent-1", "agent-start", "started", { cluster: "c-working", name: "w" }),
      ev("verify-1", "run-start", "verify", { cluster: "d-passed", verb: "verify-fix" }),
      ev("verify-1", "verdict", "passed", { cluster: "d-passed", verdict: "passed", attempt: 1 }),
    );
    expect(summarise(events).board.map((b) => b.id)).toEqual([
      "c-working",
      "app--a11y--contrast",
      "b-queued",
      "d-passed",
    ]);
  });
});

// ---------------------------------------------------------------------------

function tempProject(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-board-"));
  return {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, ".lookout/config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
}

describe("one log, several processes", () => {
  // The regression this whole board rests on: verify-fix used to open the log
  // with start(), which truncates. Ruling on one cluster therefore erased the
  // dispatches of the other twelve, and every fix session working them.
  test("a reporting run joins the board instead of erasing it", () => {
    const resolved = tempProject();
    const check = new EventLog(resolved, "check-1");
    check.start("lookout check --auto");
    check.emit("dispatch", "dispatch a", { id: "a", label: "a", routes: [] });
    check.emit("dispatch", "dispatch b", { id: "b", label: "b", routes: [] });
    check.emit("run-end", "done");

    const verify = new EventLog(resolved, "verify-1");
    verify.join("lookout verify-fix a", { cluster: "a" });
    verify.emit("verdict", "a: passed", { cluster: "a", verdict: "passed", attempt: 1 });

    const s = summarise(readEvents(resolved));
    expect(s.board.map((b) => b.id).sort()).toEqual(["a", "b"]);
    expect(s.board.find((b) => b.id === "a")!.status).toBe("passed");
    expect(s.board.find((b) => b.id === "b")!.status).toBe("queued");
    // The headline still describes the run that defined the board.
    expect(s.boardRunId).toBe("check-1");
  });

  test("a new board does discard the previous one", () => {
    const resolved = tempProject();
    const first = new EventLog(resolved, "check-1");
    first.start("lookout check --auto");
    first.emit("dispatch", "dispatch stale", { id: "stale", label: "stale", routes: [] });

    const second = new EventLog(resolved, "check-2");
    second.start("lookout check --auto");
    second.emit("dispatch", "dispatch fresh", { id: "fresh", label: "fresh", routes: [] });

    expect(summarise(readEvents(resolved)).board.map((b) => b.id)).toEqual(["fresh"]);
  });

  test("joining prunes narration once the log grows, and keeps every dispatch", () => {
    const resolved = tempProject();
    const log = new EventLog(resolved, "check-1");
    log.start("lookout check --auto");
    log.emit("dispatch", "dispatch a", { id: "a", label: "a", routes: [] });
    const path = eventsPath(resolved);
    const noise = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ at: at(), runId: "check-1", kind: "phase", message: `step ${i}` }),
    );
    writeFileSync(path, readFileSync(path, "utf8") + noise.join("\n") + "\n");

    new EventLog(resolved, "verify-1").join("lookout verify-fix a", { cluster: "a" });

    const after = readEvents(resolved);
    expect(after.length).toBeLessThan(1000);
    expect(after.filter((e) => e.kind === "dispatch")).toHaveLength(1);
    expect(summarise(after).board.map((b) => b.id)).toEqual(["a"]);
  });
});
