// The rulings `verify-fix` makes before it captures anything, and the two
// guards that decide whether a claimed fix can pass.
//
// This verb is the only thing that closes a finding, so an orchestrating session
// branches on its exit code. Every case here is one where it used to answer
// "passed", exit 0, for work it had not looked at.
import { describe, expect, test } from "bun:test";
import { emptyBacklog, type Backlog, type BacklogFinding } from "../src/backlog/lib.js";
import { reconcileIssues, issueByKey } from "../src/issues/registry.js";
import { clusterKeyOf } from "../src/fix/cluster.js";
import { baselineHashes, noOpenWork, verifyFix, withoutByDesign } from "../src/verbs/verify-fix.js";
import { LookoutError } from "../src/types.js";

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  const attribute = over.attribute ?? "theme-not-switching";
  const scheme = over.scheme ?? "dark";
  return {
    fingerprint: `app./dash.rest.desktop.${scheme}.color-scheme.${attribute}`,
    target: "app",
    route: "/dash",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme,
    category: "color-scheme",
    attribute,
    severity: "high",
    status: "open",
    reason: null,
    title: "Light scheme renders the dark theme",
    problem: "The light capture shows the dark palette.",
    expected: "A light page background with dark text.",
    observed: "Indistinguishable from the dark capture.",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [
      { shotId: "web/app/dash/rest/desktop/dark", path: "a.png", hash: "h1", runId: "r1" },
    ],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

/** A backlog with ids minted, the way every verb sees one after a load. */
function backlogOf(findings: BacklogFinding[]): Backlog {
  const b = emptyBacklog("app", "2026-01-01T00:00:00.000Z");
  for (const f of findings) b.findings[f.fingerprint] = f;
  reconcileIssues(b, "2026-01-01T00:00:00.000Z");
  return b;
}

function idOf(b: Backlog, f: BacklogFinding): string {
  const rec = issueByKey(b, clusterKeyOf(f));
  if (!rec) throw new Error("fixture has no issue id");
  return rec.id;
}

describe("nothing open under this id", () => {
  test("an id lookout has never heard of is an operator error, not a pass", () => {
    // The failure this exists for: a typoed --issue used to print "passed" and
    // exit 0, so the session that dispatched the fix recorded a verification
    // that never ran.
    const b = backlogOf([finding()]);
    expect(() => noOpenWork(b, "000123")).toThrow(LookoutError);
    try {
      noOpenWork(b, "000123");
    } catch (e) {
      expect((e as LookoutError).message).toContain("000123");
      expect((e as LookoutError).hint).toContain("lookout status");
    }
  });

  test("a blocked issue exits 3 and restates why", () => {
    const f = finding({ status: "blocked", reason: "two attempts did not clear it" });
    const b = backlogOf([f]);
    expect(noOpenWork(b, idOf(b, f))).toBe(3);
  });

  test("an issue already fixed or by-design exits 0 without claiming this run verified it", () => {
    const fixed = finding({ status: "fixed" });
    const b = backlogOf([fixed]);
    expect(noOpenWork(b, idOf(b, fixed))).toBe(0);

    const intended = finding({ status: "by-design", reason: "the hero overflows on purpose" });
    const b2 = backlogOf([intended]);
    expect(noOpenWork(b2, idOf(b2, intended))).toBe(0);
  });

  test("blocked wins over fixed siblings, because it is the one that stops dispatch", () => {
    const blocked = finding({ status: "blocked", reason: "still there" });
    // Same target, category and attribute, so both land under one cluster key
    // and one id; only the scheme axis of the fingerprint differs.
    const fixed = finding({ scheme: "light", status: "fixed" });
    const b = backlogOf([blocked, fixed]);
    expect(clusterKeyOf(blocked)).toBe(clusterKeyOf(fixed));
    expect(noOpenWork(b, idOf(b, blocked))).toBe(3);
  });

  test("an id whose findings are gone is a schema problem, not a pass", () => {
    const b = backlogOf([finding()]);
    b.findings = {};
    const id = Object.keys(b.issues)[0]!;
    expect(() => noOpenWork(b, id)).toThrow(LookoutError);
  });
});

describe("the by-design suppression the verdict shares with the merge", () => {
  test("an intentional sibling does not hold its issue open", () => {
    // Before this, an intentional defect re-fired on every capture, so the
    // issue could never pass however well the real defect was fixed, and was
    // then blocked with a reason claiming a defect persists that somebody had
    // already ruled intended.
    const intended = finding({ attribute: "hero-overflow", status: "by-design" });
    const real = finding({ attribute: "theme-not-switching", status: "open" });
    const b = backlogOf([intended, real]);

    const fresh = [intended, real];
    expect(withoutByDesign(fresh, b).map((f) => f.fingerprint)).toEqual([real.fingerprint]);
  });

  test("open and blocked findings still count", () => {
    const open = finding({ attribute: "a", status: "open" });
    const blocked = finding({ attribute: "b", status: "blocked", reason: "x" });
    const b = backlogOf([open, blocked]);
    expect(withoutByDesign([open, blocked], b)).toHaveLength(2);
  });
});

describe("the baseline the pixels-moved guard rules on", () => {
  test("a wiped evidence directory falls back to the hashes the backlog committed", () => {
    // The guard's whole job is to stop judge variance closing a real defect. An
    // empty baseline made every shot look changed, which turned it off exactly
    // when `.lookout/evidence/` had been cleaned.
    const f = finding();
    const base = baselineHashes([], [f]);
    expect(base.get("web/app/dash/rest/desktop/dark")).toBe("h1");
  });

  test("the capture report wins where both know a shot", () => {
    const f = finding();
    const base = baselineHashes([{ id: "web/app/dash/rest/desktop/dark", hash: "fresher" }], [f]);
    expect(base.get("web/app/dash/rest/desktop/dark")).toBe("fresher");
  });

  test("the latest evidence ref wins within one finding", () => {
    const f = finding({
      evidence: [
        { shotId: "s1", path: "a.png", hash: "old", runId: "r1" },
        { shotId: "s1", path: "a.png", hash: "new", runId: "r2" },
      ],
    });
    expect(baselineHashes([], [f]).get("s1")).toBe("new");
  });

  test("a shot nothing has ever seen has no baseline, so it cannot count as changed", () => {
    const base = baselineHashes([], [finding()]);
    expect(base.has("web/app/settings/rest/desktop/dark")).toBe(false);
  });
});

describe("flags that would make the ruling meaningless are refused before anything runs", () => {
  test("--no-capture rules on stale pixels", async () => {
    await expect(verifyFix({ flags: { issue: "418203", "no-capture": true }, positionals: [] })).rejects.toThrow(
      /cannot rule with --no-capture/,
    );
  });
  test("--axe off rules every accessibility criterion met without the check", async () => {
    await expect(verifyFix({ flags: { issue: "418203", axe: "off" }, positionals: [] })).rejects.toThrow(
      /cannot rule with --axe off/,
    );
  });
});
