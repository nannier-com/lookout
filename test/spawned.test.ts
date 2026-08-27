// A fix that clears its own defect and causes another one somewhere else.
//
// This used to come back as `regressed` on the ticket being verified: its
// findings stayed open, every member burned an attempt, and two rounds of it
// blocked an issue whose defect had actually been fixed, with a written reason
// claiming the defect persisted. The new defect is new work, so it gets its own
// number, and the issue that surfaced it gets a line of history, not a verdict.
import { describe, expect, test } from "bun:test";
import { spawnedIssues, stampCausedBy } from "../src/issues/spawned.js";
import { reconcileIssues } from "../src/issues/registry.js";
import { emptyBacklog, type Backlog, type BacklogFinding } from "../src/backlog/lib.js";

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  const attribute = over.attribute ?? "theme-not-switching";
  const shotId = over.evidence?.[0]?.shotId ?? "web/app/dash/rest/desktop/dark";
  return {
    fingerprint: `app./dash.rest.desktop.dark.color-scheme.${attribute}`,
    target: "app",
    route: "/dash",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "dark",
    category: "color-scheme",
    attribute,
    severity: "high",
    status: "open",
    reason: null,
    title: `defect: ${attribute}`,
    problem: "p",
    expected: "e",
    observed: "o",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [{ shotId, path: `${shotId}.png`, hash: "h", runId: "r1" }],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

function backlogOf(findings: BacklogFinding[]): Backlog {
  const b = emptyBacklog("app", "t");
  for (const f of findings) b.findings[f.fingerprint] = f;
  reconcileIssues(b, "t");
  return b;
}

const CHANGED = new Set(["web/app/dash/rest/desktop/dark"]);

describe("what a fix surfaced", () => {
  test("a defect that appeared on pixels the fix moved is a new issue, attributed", () => {
    const before = backlogOf([finding()]);
    const originalId = Object.values(before.issues)[0]!.id;

    // What a real run does: load the backlog, merge the fresh findings into it,
    // reconcile. The original keeps its number; the new root cause gets one.
    const after = JSON.parse(JSON.stringify(before)) as Backlog;
    const collateral = finding({
      fingerprint: "new",
      category: "spacing",
      attribute: "button-gap",
    });
    after.findings[collateral.fingerprint] = collateral;
    reconcileIssues(after, "t");

    const spawned = spawnedIssues(before, after, CHANGED, originalId);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.causedByThisFix).toBe(true);

    const stamped = stampCausedBy(after, spawned, {
      issue: originalId,
      commit: "abc1234",
      runId: "verify-1",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(stamped).toEqual([spawned[0]!.issue.id]);
    expect(after.issues[spawned[0]!.issue.id]!.causedBy).toEqual({
      issue: originalId,
      commit: "abc1234",
      runId: "verify-1",
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("a defect on a screenshot that did not move is filed, but not blamed on the fix", () => {
    // Nothing that ran could have caused it: the pixels are byte-identical, so
    // this is the judge reading the same image differently today.
    const before = backlogOf([finding()]);
    const after = JSON.parse(JSON.stringify(before)) as Backlog;
    const elsewhere = finding({
      fingerprint: "elsewhere",
      category: "spacing",
      attribute: "gap",
      evidence: [
        { shotId: "web/app/other/rest/phone/light", path: "x.png", hash: "h2", runId: "r1" },
      ],
    });
    after.findings[elsewhere.fingerprint] = elsewhere;
    reconcileIssues(after, "t");
    const spawned = spawnedIssues(before, after, CHANGED);
    const fresh = spawned.find((s) => s.issue.category === "spacing")!;
    expect(fresh).toBeDefined();
    expect(fresh.causedByThisFix).toBe(false);
    expect(stampCausedBy(after, spawned, {
      issue: "111111",
      commit: null,
      runId: "verify-1",
      at: "t",
    })).not.toContain(fresh.issue.id);
    expect(after.issues[fresh.issue.id]!.causedBy).toBeUndefined();
  });

  test("an issue that already existed is not counted as new", () => {
    const before = backlogOf([finding()]);
    const after: Backlog = JSON.parse(JSON.stringify(before)) as Backlog;
    expect(spawnedIssues(before, after, CHANGED)).toHaveLength(0);
  });

  test("the issue being verified is never counted as its own collateral", () => {
    const before = emptyBacklog("app", "t");
    const after = backlogOf([finding()]);
    const id = Object.values(after.issues)[0]!.id;
    expect(spawnedIssues(before, after, CHANGED, id)).toHaveLength(0);
  });

  test("provenance is written once: a later run does not rewrite who caused it", () => {
    const before = emptyBacklog("app", "t");
    const after = backlogOf([finding()]);
    const spawned = spawnedIssues(before, after, CHANGED);
    const first = { issue: "111111", commit: "aaa", runId: "r1", at: "t1" };
    expect(stampCausedBy(after, spawned, first)).toHaveLength(1);
    expect(stampCausedBy(after, spawned, { issue: "222222", commit: "bbb", runId: "r2", at: "t2" })).toHaveLength(0);
    expect(after.issues[spawned[0]!.issue.id]!.causedBy).toEqual(first);
  });
});
