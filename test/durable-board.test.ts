// Outstanding work is state, not narration.
//
// The board was a fold over `events.jsonl` alone, which every `check` or
// `capture` run truncates. A project with thirty-seven open findings and
// eighteen briefs on disk therefore showed "nothing dispatched yet" the moment
// anything re-captured, and every record of who fixed what went with it. These
// pin the rebuild: the board comes from the backlog and the per-cluster state
// files, and the event log only ever lays what is happening now over the top.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard, tally } from "../src/report/board.js";
import { EventLog } from "../src/report/events.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import type { ClusterState } from "../src/fix/state.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-durable-"));
  mkdirSync(join(dir, ".lookout", "evidence", "fix"), { recursive: true });
  return {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, ".lookout/config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
}

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  const route = over.route ?? "/dash";
  const attribute = over.attribute ?? "contrast";
  const formFactor = over.formFactor ?? "desktop";
  const scheme = over.scheme ?? "dark";
  return {
    fingerprint: `app.${route}.rest.${formFactor}.${scheme}.a11y.${attribute}`,
    target: "app",
    route,
    state: "rest",
    platform: "web",
    formFactor,
    scheme,
    category: "a11y",
    attribute,
    severity: "high",
    status: "open",
    reason: null,
    title: "Body text is too faint",
    problem: "2.9:1 against the card surface.",
    expected: "At least 4.5:1.",
    observed: "2.9:1.",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [
      {
        shotId: `web/app${route}/rest/${formFactor}/${scheme}`,
        path: `web/app${route}/rest--${formFactor}-${scheme}.png`,
        hash: "h1",
        runId: "r1",
      },
    ],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

function writeBacklog(r: ResolvedConfig, findings: BacklogFinding[]): void {
  writeFileSync(
    join(r.projectDir, ".lookout", "backlog.json"),
    JSON.stringify({
      note: "",
      project: "app",
      updatedAt: new Date(0).toISOString(),
      findings: Object.fromEntries(findings.map((f) => [f.fingerprint, f])),
    }),
  );
}

function writeState(r: ResolvedConfig, state: ClusterState): void {
  writeFileSync(
    join(r.projectDir, ".lookout", "evidence", "fix", `${state.id}.state.json`),
    JSON.stringify(state),
  );
}

function writeBrief(r: ResolvedConfig, id: string): void {
  writeFileSync(join(r.projectDir, ".lookout", "evidence", "fix", `${id}.md`), "# brief\n");
}

describe("the board survives a truncated log", () => {
  test("outstanding work is rebuilt from the backlog with no events at all", async () => {
    const r = project();
    writeBacklog(r, [finding(), finding({ attribute: "target-size", route: "/settings" })]);
    // Not one event on disk: exactly the state after a `check` truncated the
    // log, or after the machine was restarted.
    const board = await buildBoard(r);
    expect(board).toHaveLength(2);
    expect(board.every((b) => b.shots.length > 0)).toBe(true);
    expect(tally(board)).toEqual({ queued: 2, working: 0, reported: 0, resolved: 0 });
  });

  test("blocked work stays on the board rather than vanishing", async () => {
    const r = project();
    writeBacklog(r, [
      finding(),
      finding({ attribute: "target-size", status: "blocked", reason: "upstream", fixAttempts: 3 }),
    ]);
    const board = await buildBoard(r);
    expect(board.map((b) => b.status).sort()).toEqual(["blocked", "queued"]);
    // Blocked is settled work: it must not read as something awaiting a session.
    expect(tally(board)).toEqual({ queued: 1, working: 0, reported: 0, resolved: 1 });
  });

  test("a fix session's history outlives the run that recorded it", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    const id = "app--a11y--contrast";
    writeBrief(r, id);
    writeState(r, {
      id,
      attempts: [],
      sessions: [
        {
          name: "contrast fixer",
          startedAt: "2026-01-01T10:00:00.000Z",
          lastSeenAt: "2026-01-01T10:12:00.000Z",
          finishedAt: "2026-01-01T10:12:00.000Z",
          reported: { commit: "abc1234", note: "raised the token" },
          notes: [
            { at: "2026-01-01T10:03:00.000Z", text: "opened both screenshots" },
            { at: "2026-01-01T10:07:00.000Z", text: "the token never reaches the dark palette" },
          ],
        },
      ],
    });
    const b = (await buildBoard(r))[0]!;
    expect(b.status).toBe("reported");
    expect(b.agent?.name).toBe("contrast fixer");
    expect(b.agent?.commit).toBe("abc1234");
    // The whole account is rebuilt from the state file, with no log involved.
    expect(b.timeline.map((s) => s.kind)).toEqual(["dispatch", "start", "note", "note", "done"]);
    expect(b.timeline[2]!.text).toBe("opened both screenshots");
  });

  test("a verdict recorded against a cluster survives too", async () => {
    const r = project();
    writeBacklog(r, [finding({ fixAttempts: 1 })]);
    const id = "app--a11y--contrast";
    writeBrief(r, id);
    writeState(r, {
      id,
      attempts: [
        {
          n: 1,
          dispatchedAt: "2026-01-01T09:00:00.000Z",
          verdict: "regressed",
          judgeNote: "the fix introduced 2 new findings",
        },
      ],
    });
    const b = (await buildBoard(r))[0]!;
    expect(b.status).toBe("regressed");
    expect(b.verdict).toBe("regressed");
    expect(b.judgeNote).toContain("2 new findings");
    expect(b.attempt).toBe(1);
  });

  test("work never sent out says so instead of claiming a 1970 dispatch", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    // No brief, no attempt: outstanding, but nobody has ever been given it.
    const b = (await buildBoard(r))[0]!;
    expect(b.dispatchedAt).toBeNull();
    expect(b.timeline).toEqual([]);
  });
});

describe("the log lays over the board without replacing it", () => {
  test("a re-judge in flight is the one status only the log knows", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    const id = "app--a11y--contrast";
    writeBrief(r, id);
    const log = new EventLog(r, "check-1");
    log.start("lookout check --auto");
    log.emit("run-end", "done");
    const verify = new EventLog(r, "verify-1");
    verify.join("lookout verify-fix", { cluster: id, verb: "verify-fix" });

    const b = (await buildBoard(r))[0]!;
    expect(b.status).toBe("verifying");
    // Disk still owns what the work IS.
    expect(b.shots).toHaveLength(1);
  });

  test("a cluster the backlog has closed still shows while the run is up", async () => {
    const r = project();
    writeBacklog(r, []);   // nothing open: the fix landed and closed it
    const log = new EventLog(r, "check-1");
    log.start("lookout check --auto");
    log.emit("dispatch", "dispatch app--a11y--contrast", {
      id: "app--a11y--contrast",
      label: "fix a11y/contrast on /dash",
      routes: ["/dash"],
      severity: "high",
      category: "a11y",
      shots: [],
    });
    log.emit("verdict", "passed", {
      cluster: "app--a11y--contrast",
      verdict: "passed",
      attempt: 1,
    });
    const board = await buildBoard(r);
    expect(board.map((b) => b.status)).toEqual(["passed"]);
  });

  test("the log cannot resurrect work the backlog says is settled", async () => {
    const r = project();
    writeBacklog(r, [finding({ status: "blocked", reason: "upstream bug", fixAttempts: 3 })]);
    const log = new EventLog(r, "check-1");
    log.start("lookout check --auto");
    log.emit("dispatch", "dispatch app--a11y--contrast", {
      id: "app--a11y--contrast",
      label: "fix a11y/contrast on /dash",
      routes: ["/dash"],
      severity: "high",
      category: "a11y",
      shots: [],
    });
    // The log's dispatch says queued; the backlog says blocked, and it wins.
    expect((await buildBoard(r))[0]!.status).toBe("blocked");
  });
});
