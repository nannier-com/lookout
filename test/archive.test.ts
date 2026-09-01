// Filing a settled issue away: the record says it, the folder follows, and a
// defect that comes back undoes both.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveIssue, reconcileIssues, unarchiveIssue } from "../src/issues/registry.js";
import { issueArchiveDir, issueDir } from "../src/issues/paths.js";
import { buildBoard } from "../src/report/board.js";
import { loadBacklog, saveBacklog } from "../src/verbs/backlog.js";
import type { Backlog, BacklogFinding } from "../src/backlog/lib.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-archive-"));
  mkdirSync(join(dir, ".lookout", "evidence", "web", "app"), { recursive: true });
  writeFileSync(join(dir, ".lookout", "evidence", "web", "app", "settings--desktop-dark.png"), "px");
  return {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
}

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  return {
    fingerprint: "app./settings.rest.desktop.dark.spacing.rhythm",
    target: "app",
    route: "/settings",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "dark",
    category: "spacing",
    attribute: "rhythm",
    severity: "medium",
    status: "fixed",
    reason: null,
    title: "Settings rows have no rhythm",
    problem: "p",
    expected: "e",
    observed: "o",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [
      {
        shotId: "web/app/settings/rest/desktop/dark",
        path: "web/app/settings--desktop-dark.png",
        hash: "h1",
        runId: "r1",
      },
    ],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 1,
    fixedIn: { commit: "abc1234", runId: "v1" },
    ...over,
  } as BacklogFinding;
}

function backlogWith(findings: BacklogFinding[]): Backlog {
  const b = {
    note: "",
    project: "app",
    updatedAt: new Date(0).toISOString(),
    findings: Object.fromEntries(findings.map((f) => [f.fingerprint, f])),
    issues: {},
  } as unknown as Backlog;
  reconcileIssues(b, "2026-01-01T00:00:00.000Z");
  return b;
}

const idOf = (b: Backlog) => Object.keys(b.issues ?? {})[0]!;

describe("filing an issue away", () => {
  test("records why it was archived, so a fix is never called a decision", () => {
    const b = backlogWith([finding()]);
    const out = archiveIssue(b, idOf(b), "2026-02-02T00:00:00.000Z");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.reason).toBe("fixed");
    expect(b.issues![idOf(b)]!.archived).toEqual({
      at: "2026-02-02T00:00:00.000Z",
      reason: "fixed",
    });
  });

  test("a waived issue archives as intentional, which is the older meaning", () => {
    const b = backlogWith([finding({ status: "by-design", reason: "the hero is meant to bleed" })]);
    const out = archiveIssue(b, idOf(b), "now");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.reason).toBe("intentional");
  });

  test("refuses to hide work that is still open", () => {
    const b = backlogWith([finding({ status: "open", fixedIn: null })]);
    const out = archiveIssue(b, idOf(b), "now");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.why).toContain("still open");
    expect(b.issues![idOf(b)]!.archived).toBeUndefined();
  });

  test("archiving twice is what a double click means, not an error", () => {
    const b = backlogWith([finding()]);
    archiveIssue(b, idOf(b), "first");
    const again = archiveIssue(b, idOf(b), "second");
    expect(again.ok).toBe(true);
    // The first act is the one that happened.
    expect(b.issues![idOf(b)]!.archived!.at).toBe("first");
  });

  test("restore puts it back", () => {
    const b = backlogWith([finding()]);
    archiveIssue(b, idOf(b), "now");
    expect(unarchiveIssue(b, idOf(b)).ok).toBe(true);
    expect(b.issues![idOf(b)]!.archived).toBeUndefined();
  });

  test("says so plainly when there is no such issue", () => {
    const b = backlogWith([finding()]);
    const out = archiveIssue(b, "000000", "now");
    expect(out.ok).toBe(false);
  });
});

describe("a defect that comes back", () => {
  test("un-archives itself, because work nobody can see is work nobody does", () => {
    const b = backlogWith([finding()]);
    archiveIssue(b, idOf(b), "now");
    // The next check re-finds it: the finding reopens.
    Object.values(b.findings)[0]!.status = "open";
    reconcileIssues(b, "later");
    expect(b.issues![idOf(b)]!.archived).toBeUndefined();
  });
});

describe("the folder follows the record", () => {
  test("a save moves the folder into the archive, and a restore moves it back", async () => {
    const r = project();
    writeFileSync(
      join(r.projectDir, ".lookout", "backlog.json"),
      JSON.stringify(backlogWith([finding()])),
    );
    let b = await loadBacklog(r);
    const id = idOf(b);
    await saveBacklog(r, b);
    expect(existsSync(join(r.projectDir, ".lookout", "issues", id, "Issue.md"))).toBe(true);

    b = await loadBacklog(r);
    archiveIssue(b, id, "now");
    await saveBacklog(r, b);
    // Moved, not copied: two folders for one issue would be two answers to
    // "where is this", and only one of them holds state.json.
    expect(existsSync(issueArchiveDir(r, id))).toBe(true);
    expect(existsSync(join(r.projectDir, ".lookout", "issues", id, "Issue.md"))).toBe(false);
    // Readers that only have an id follow it without being told.
    expect(issueDir(r, id)).toBe(issueArchiveDir(r, id));

    b = await loadBacklog(r);
    unarchiveIssue(b, id);
    await saveBacklog(r, b);
    expect(existsSync(join(r.projectDir, ".lookout", "issues", id, "Issue.md"))).toBe(true);
    expect(existsSync(join(issueArchiveDir(r, id), "Issue.md"))).toBe(false);
  });

  test("the board reads it as archived, and says which kind", async () => {
    const r = project();
    writeFileSync(
      join(r.projectDir, ".lookout", "backlog.json"),
      JSON.stringify(backlogWith([finding()])),
    );
    const b = await loadBacklog(r);
    const id = idOf(b);
    archiveIssue(b, id, "2026-02-02T00:00:00.000Z");
    await saveBacklog(r, b);

    const entry = (await buildBoard(r))[0]!;
    expect(entry.status).toBe("archived");
    expect(entry.archived).toEqual({ at: "2026-02-02T00:00:00.000Z", reason: "fixed" });
    // The fix it was archived after is still on the card.
    expect(entry.fix?.cleared).toBe(true);
  });
});
