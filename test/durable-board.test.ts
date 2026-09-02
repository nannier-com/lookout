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
import { execFileSync } from "node:child_process";
import { buildBoard, severityTally, tally } from "../src/report/board.js";
import { evidenceDir } from "../src/config.js";
import { forgetForges } from "../src/report/forge.js";
import { EventLog } from "../src/report/events.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import { statePath, type ClusterState } from "../src/fix/state.js";
import { attemptSentences } from "../src/fix/attempts.js";
import type { AttemptRecord } from "../src/fix/state.js";
import { issueByKey } from "../src/issues/registry.js";
import { loadBacklog } from "../src/verbs/backlog.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-durable-"));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const r = {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
  mkdirSync(evidenceDir(r), { recursive: true });
  return r;
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
  const p = statePath(r, state.id);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(state));
}

/**
 * The id lookout minted for a root cause. Random by design, so a test that
 * needs it has to ask rather than name it; loading the backlog is what mints
 * it, exactly as any verb would.
 */
async function idOf(r: ResolvedConfig, key = "app--a11y--contrast"): Promise<string> {
  const backlog = await loadBacklog(r);
  const record = issueByKey(backlog, key);
  if (!record) throw new Error(`no issue for key ${key}`);
  return record.id;
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
    expect(tally(board)).toEqual({ open: 2, verifying: 0, blocked: 0, done: 0, archived: 0 });
  });

  test("blocked work stays on the board rather than vanishing", async () => {
    const r = project();
    writeBacklog(r, [
      finding(),
      finding({ attribute: "target-size", status: "blocked", reason: "upstream", fixAttempts: 3 }),
    ]);
    const board = await buildBoard(r);
    expect(board.map((b) => b.status).sort()).toEqual(["blocked", "open"]);
    // Blocked is counted on its own: lookout gave up on it and it still needs
    // fixing, so it must read neither as awaiting a session nor as done.
    expect(tally(board)).toEqual({ open: 1, verifying: 0, blocked: 1, done: 0, archived: 0 });
  });

  test("a verdict recorded against an issue survives too", async () => {
    const r = project();
    writeBacklog(r, [finding({ fixAttempts: 1 })]);
    const id = await idOf(r);
    writeState(r, {
      id,
      attempts: [
        {
          n: 1,
          dispatchedAt: "2026-01-01T09:00:00.000Z",
          verdict: "still-open",
          judgeNote: "the heading is still obscured",
        },
      ],
    });
    const b = (await buildBoard(r))[0]!;
    expect(b.status).toBe("still-open");
    expect(b.verdict).toBe("still-open");
    expect(b.judgeNote).toContain("still obscured");
    expect(b.attempt).toBe(1);
  });

  test("what a fix surfaced elsewhere is recorded as history, not as a verdict", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    const id = await idOf(r);
    writeState(r, {
      id,
      attempts: [
        {
          n: 1,
          dispatchedAt: "2026-01-01T09:00:00.000Z",
          verdict: "passed",
          spawned: ["418203"],
        },
      ],
    });
    const b = (await buildBoard(r))[0]!;
    // The issue is not blamed for it: no regression, no attempt charged.
    expect(b.timeline.some((s) => s.text === "fixing this surfaced issue 418203")).toBe(true);
    expect(b.status).not.toBe("still-open");
  });

  test("an issue whose evidence is gone says so instead of inventing a date", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    // The backlog names a screenshot that is not on disk, so lookout cannot
    // say how current the finding is. Better to say nothing than to date it.
    const b = (await buildBoard(r))[0]!;
    expect(b.lastSeenAt).toBeNull();
    expect(b.timeline).toEqual([]);
  });

  test("every screenshot carries an absolute path for whoever picks it up", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    const b = (await buildBoard(r))[0]!;
    expect(b.shots[0]!.path).toBe("web/app/dash/rest--desktop-dark.png");
    expect(b.shots[0]!.absPath).toBe(
      join(evidenceDir(r), "web/app/dash/rest--desktop-dark.png"),
    );
  });

  test("a shot advertises its provenance sidecar exactly when one sits beside the PNG", async () => {
    // The client never probes: a probe's 404 is a console error the ui gate
    // fails on, so presence is decided here, on disk.
    const r = project();
    writeBacklog(r, [finding()]);
    const bare = (await buildBoard(r))[0]!;
    expect(bare.shots[0]!.provenance).toBeUndefined();

    mkdirSync(join(evidenceDir(r), "web/app/dash"), { recursive: true });
    writeFileSync(
      join(evidenceDir(r), "web/app/dash/rest--desktop-dark.png.provenance.json"),
      JSON.stringify({ version: 1, elements: [] }),
    );
    const advertised = (await buildBoard(r))[0]!;
    expect(advertised.shots[0]!.provenance).toBe(
      "web/app/dash/rest--desktop-dark.png.provenance.json",
    );
  });
});

describe("the log only marks what is in flight", () => {
  test("a re-judge in flight is the one status only the log knows", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    const id = await idOf(r);
    const log = new EventLog(r, "check-1");
    log.start("lookout check");
    log.emit("run-end", "done");
    const verify = new EventLog(r, "verify-1");
    verify.join("lookout verify-fix", { issue: id, verb: "verify-fix" });

    const b = (await buildBoard(r))[0]!;
    expect(b.status).toBe("verifying");
    // Disk still owns what the work IS.
    expect(b.shots).toHaveLength(1);
  });

  test("a re-judge of a blocked issue does not reopen it", async () => {
    const r = project();
    writeBacklog(r, [finding({ status: "blocked", reason: "upstream bug", fixAttempts: 3 })]);
    const log = new EventLog(r, "check-1");
    log.start("lookout check");
    log.emit("run-end", "done");
    const verify = new EventLog(r, "verify-1");
    verify.join("lookout verify-fix", { issue: await idOf(r), verb: "verify-fix" });
    // The backlog says blocked, and it wins over anything in flight.
    expect((await buildBoard(r))[0]!.status).toBe("blocked");
  });
});

describe("an issue carries its own defects and its own severity", () => {
  // These used to be asserted over a separate findings list. That list showed
  // the same screenshot and the same severity next to a pointer back to the
  // issue, so it was folded in: the invariants belong to the issue now.
  test("the judge's words travel with the issue, not in a second list", async () => {
    const r = project();
    writeBacklog(r, [finding()]);
    const b = (await buildBoard(r))[0]!;
    expect(b.defects).toHaveLength(1);
    expect(b.defects[0]!.problem).toBe("2.9:1 against the card surface.");
    expect(b.defects[0]!.title).toBe("Body text is too faint");
  });

  test("a root cause seen twice is one issue listing one defect", async () => {
    const r = project();
    writeBacklog(r, [
      finding(),
      finding({
        fingerprint: "app./dash.rest.phone.dark.a11y.contrast",
        formFactor: "phone",
        evidence: [
          {
            shotId: "web/app/dash/rest/phone/dark",
            path: "web/app/dash/rest--phone-dark.png",
            hash: "h2",
            runId: "r1",
          },
        ],
      }),
    ]);
    const board = await buildBoard(r);
    expect(board).toHaveLength(1);
    // One defect, two screenshots: the same thing seen twice.
    expect(board[0]!.defects).toHaveLength(1);
    expect(board[0]!.shots).toHaveLength(2);
  });

  test("severity counts issues, and leaves settled work out of the count", async () => {
    const r = project();
    writeBacklog(r, [
      finding({ severity: "critical" }),
      finding({ attribute: "target-size", severity: "high" }),
      finding({ attribute: "focus-ring", severity: "high", status: "blocked", reason: "upstream" }),
      // Already fixed: it must not keep inflating the number somebody triages by.
      finding({ attribute: "closed", severity: "critical", status: "fixed" }),
    ]);
    const board = await buildBoard(r);
    const outstanding = board.filter((b) => b.status !== "done" && b.status !== "archived");
    expect(severityTally(outstanding)).toEqual({
      critical: 1, high: 2, medium: 0, low: 0, total: 3,
    });
  });
});

// The commit a fix landed in, as something a person can open. lookout has
// always recorded the sha; a card that only prints it makes the reader go and
// find the diff themselves.
describe("the commit behind an issue", () => {
  function gitProject(remote?: string): ResolvedConfig {
    const r = project();
    execFileSync("git", ["init", "-q"], { cwd: r.projectDir });
    if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: r.projectDir });
    forgetForges();
    return r;
  }

  test("a ruled fix links to the commit on the project's own forge", async () => {
    const r = gitProject("git@github.com:acme/app.git");
    writeBacklog(r, [
      finding({ status: "fixed", fixedIn: { commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", runId: "v1" } }),
    ]);
    const board = await buildBoard(r);
    expect(board[0]!.status).toBe("done");
    const fix = board[0]!.fix!;
    expect(fix.cleared).toBe(true);
    expect(fix.short).toBe("a1b2c3d4");
    expect(fix.host).toBe("github.com");
    expect(fix.url).toBe("https://github.com/acme/app/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  });

  test("a reported commit is carried too, and marked as not yet ruled on", async () => {
    const r = gitProject("git@github.com:acme/app.git");
    writeBacklog(r, [finding({ fixAttempts: 1 })]);
    const id = await idOf(r);
    writeState(r, {
      id,
      attempts: [
        {
          n: 1,
          dispatchedAt: "2026-01-01T09:00:00.000Z",
          reported: { commit: "deadbee", note: "raised the contrast" },
          verdict: "still-open",
        },
      ],
    } as ClusterState);
    const fix = (await buildBoard(r))[0]!.fix!;
    // Still a claim: lookout has not agreed the defect is gone, and the card
    // must not say "fixed in" about it.
    expect(fix.cleared).toBe(false);
    expect(fix.url).toBe("https://github.com/acme/app/commit/deadbee");
  });

  test("a checkout with no remote still shows the sha, with nowhere to send you", async () => {
    const r = gitProject();
    writeBacklog(r, [
      finding({ status: "fixed", fixedIn: { commit: "a1b2c3d4e5f6071829", runId: "v1" } }),
    ]);
    const fix = (await buildBoard(r))[0]!.fix!;
    expect(fix.short).toBe("a1b2c3d4");
    expect(fix.url).toBeNull();
    expect(fix.host).toBeNull();
  });

  test("an issue nobody has claimed a fix for carries no commit at all", async () => {
    const r = gitProject("git@github.com:acme/app.git");
    writeBacklog(r, [finding()]);
    expect((await buildBoard(r))[0]!.fix).toBeNull();
  });
});

describe("the record feed and the issue document say the same thing about an attempt", () => {
  // Both surfaces print these; a fixer who reads the card and then the file
  // has to recognise every line, so the sentences are pinned byte for byte.
  test("the three sentences, byte for byte", () => {
    const a: AttemptRecord = {
      n: 1,
      dispatchedAt: "2026-01-01T09:00:00.000Z",
      reported: { commit: "deadbee", note: "raised the contrast" },
      verdict: "still-open",
      judgeNote: "the heading is still obscured",
      spawned: ["418203"],
    };
    expect(attemptSentences(a)).toEqual({
      claimed: "a fix was reported at deadbee: raised the contrast",
      surfaced: "fixing this surfaced issue 418203",
      verdict: "lookout ruled it still-open: the heading is still obscured",
    });
  });

  test("a commit alone, a note alone, several surfaced issues, a verdict without a note", () => {
    expect(attemptSentences({ n: 1, dispatchedAt: "t", reported: { commit: "deadbee" } }).claimed).toBe(
      "a fix was reported at deadbee",
    );
    expect(attemptSentences({ n: 1, dispatchedAt: "t", reported: { note: "tried" } }).claimed).toBe(
      "a fix was reported: tried",
    );
    expect(attemptSentences({ n: 1, dispatchedAt: "t", spawned: ["1", "2"] }).surfaced).toBe(
      "fixing this surfaced issues 1, 2",
    );
    expect(attemptSentences({ n: 1, dispatchedAt: "t", verdict: "passed" }).verdict).toBe("lookout ruled it passed");
  });

  test("nothing reported, nothing surfaced, not ruled: nothing said", () => {
    expect(attemptSentences({ n: 1, dispatchedAt: "t" })).toEqual({});
  });
});
