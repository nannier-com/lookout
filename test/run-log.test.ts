// The run log: what lookout is doing right now, and nothing else.
//
// What issues exist is a question for the backlog, which outlives any run.
// This file covers the log's own behaviour: that a reporting run joins the
// narration rather than erasing it, that a fresh capture does discard the
// previous one, and that a run killed without emitting run-end is not reported
// as live forever.
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

/** The events one `check` writes. */
function checkRun(): LookoutEvent[] {
  return [
    ev("check-1", "run-start", "lookout check", { project: "app" }),
    ev("check-1", "shot", "app/dash desktop dark", shot("/dash", "desktop", "dark")),
    ev("check-1", "shot", "app/dash phone dark", shot("/dash", "phone", "dark")),
    ev("check-1", "finding", "a11y/contrast: too faint", { severity: "high" }),
    ev("check-1", "run-end", "1 finding(s)", { findings: 1 }),
  ];
}

describe("the headline describes the run that captured the evidence", () => {
  test("counts come from the capture, not from a later re-judge", () => {
    const events = checkRun();
    events.push(
      ev("verify-1", "run-start", "lookout verify-fix", {
        issue: "418203",
        verb: "verify-fix",
      }),
      ev("verify-1", "shot", "app/dash desktop dark", shot("/dash", "desktop", "dark")),
      ev("verify-1", "shot", "app/dash phone dark", shot("/dash", "phone", "dark")),
    );
    const s = summarise(events);
    // Two in the check, two more in the re-check: it stays 2, not 4.
    expect(s.shots).toBe(2);
    expect(s.findings.high).toBe(1);
    expect(s.phase).toBe("re-judging 418203");
  });

  test("a re-judge names its issue rather than echoing its raw run message", () => {
    const events = checkRun();
    events.push(
      ev("verify-1", "run-start", "lookout verify-fix 418203", {
        issue: "418203",
        verb: "verify-fix",
      }),
    );
    expect(summarise(events).phase).toBe("re-judging 418203");
  });
});

describe("a run that was killed is not reported as live", () => {
  // lookout cannot see a process die. A verify-fix killed mid-judge never
  // emits run-end, so the log says running forever: the page showed a pulsing
  // live dot and a clock climbing past five hours. Silence is the only
  // evidence available, so the fold surfaces it.
  test("the fold reports when the run last said anything", () => {
    const events = checkRun();
    const s = summarise(events);
    expect(s.lastEventAt).toBe(events[events.length - 1]!.at);
    expect(s.running).toBe(false);
  });

  test("a run with no run-end still says running, and says when it last spoke", () => {
    const events = checkRun().filter((e) => e.kind !== "run-end");
    events.push(
      ev("verify-1", "run-start", "lookout verify-fix", {
        issue: "418203",
        verb: "verify-fix",
      }),
      ev("verify-1", "phase", "judging"),
    );
    const s = summarise(events);
    expect(s.running).toBe(true);
    // Callers compare this against the clock; the fold stays pure and does not
    // decide staleness itself, so `status` and the page share one rule.
    expect(s.lastEventAt).toBe(events[events.length - 1]!.at);
    expect(Date.parse(s.lastEventAt!)).toBeGreaterThan(Date.parse(s.startedAt!));
  });

  // A run that judges in rounds (one per route on a --first walk, one per
  // screen on a map walk) announces each round's batches as it reaches them.
  // Assigning the last announcement made `status` print "7/1" once the
  // second round started: seven batches done out of the one it was told about.
  test("judge-start counts batches across rounds instead of keeping the last round's", () => {
    const events = checkRun().filter((e) => e.kind !== "run-end");
    events.push(
      ev("check-1", "judge-start", "judging 4 shot(s)", { batches: 2 }),
      ev("check-1", "batch", "batch 1/2"),
      ev("check-1", "batch", "batch 2/2"),
      ev("check-1", "judge-start", "judging 2 shot(s)", { batches: 1 }),
      ev("check-1", "batch", "batch 1/1"),
    );
    const s = summarise(events);
    expect(s.batches).toEqual({ done: 3, total: 3 });
  });

  test("an empty log has nothing to report rather than a bogus timestamp", () => {
    const s = summarise([]);
    expect(s.lastEventAt).toBeNull();
    expect(s.running).toBe(false);
  });
});

function tempProject(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-log-"));
  return {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
}

describe("one log, several processes", () => {
  test("a reporting run joins the narration instead of erasing it", () => {
    const resolved = tempProject();
    const check = new EventLog(resolved, "check-1");
    check.start("lookout check");
    check.emit("finding", "a11y/contrast: too faint", { severity: "high" });
    check.emit("run-end", "done");

    const verify = new EventLog(resolved, "verify-1");
    verify.join("lookout verify-fix a", { issue: "418203", verb: "verify-fix" });
    verify.emit("verdict", "a: passed", { issue: "418203", verdict: "passed", attempt: 1 });

    const events = readEvents(resolved);
    expect(events.filter((e) => e.kind === "finding")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "verdict")).toHaveLength(1);
    expect(summarise(events).findings.high).toBe(1);
  });

  // A tool server spawned by a run narrates into that run's board: it neither
  // starts a run of its own nor erases the one in flight.
  test("an attached log appends to the run in flight without a run-start of its own", () => {
    const resolved = tempProject();
    const check = new EventLog(resolved, "check-1");
    check.start("lookout check");
    check.emit("finding", "a11y/contrast: too faint", { severity: "high" });

    const server = EventLog.attach(resolved, "check-1");
    server.emit("phase", "navigator: click \"Menu\"");

    const events = readEvents(resolved);
    expect(events.filter((e) => e.kind === "run-start")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "finding")).toHaveLength(1);
    expect(events.at(-1)?.message).toBe("navigator: click \"Menu\"");
    expect(summarise(events).running).toBe(true);
  });

  test("a fresh capture does discard the previous run", () => {
    const resolved = tempProject();
    const first = new EventLog(resolved, "check-1");
    first.start("lookout check");
    first.emit("finding", "stale finding", { severity: "high" });

    const second = new EventLog(resolved, "check-2");
    second.start("lookout check");
    second.emit("finding", "fresh finding", { severity: "low" });

    const events = readEvents(resolved);
    expect(events.filter((e) => e.kind === "finding").map((e) => e.message)).toEqual([
      "fresh finding",
    ]);
  });

  test("joining prunes narration once the log grows, and keeps the structure", () => {
    const resolved = tempProject();
    const log = new EventLog(resolved, "check-1");
    log.start("lookout check");
    log.emit("finding", "a11y/contrast", { severity: "high" });
    const path = eventsPath(resolved);
    const noise = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ at: at(), runId: "check-1", kind: "phase", message: `step ${i}` }),
    );
    writeFileSync(path, readFileSync(path, "utf8") + noise.join("\n") + "\n");

    new EventLog(resolved, "verify-1").join("lookout verify-fix a", {
      issue: "418203",
      verb: "verify-fix",
    });

    const after = readEvents(resolved);
    expect(after.length).toBeLessThan(1000);
    expect(after.filter((e) => e.kind === "finding")).toHaveLength(1);
  });
});
