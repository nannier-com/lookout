// The per-member closure guard: an AI member may close only when its own
// pixels moved. Before this, a two-route cluster passed when one route was
// edited and judged clean while the other's stale views were served from
// cache, closing the untouched member on silence.
import { describe, expect, test } from "bun:test";
import { unclosableMembers } from "../src/verify/closure.js";
import { ruleVerdict } from "../src/fix/rule.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import type { FixCluster } from "../src/fix/cluster.js";

function member(over: Partial<BacklogFinding>): BacklogFinding {
  return {
    fingerprint: "fp",
    target: "app",
    route: "/home",
    state: "rest",
    channel: "ai",
    category: "color-scheme",
    attribute: "theme",
    severity: "high",
    title: "t",
    problem: "p",
    expected: "e",
    observed: "o",
    status: "open",
    reason: null,
    firstSeen: "t",
    lastSeen: "t",
    fixAttempts: 0,
    verified: false,
    evidence: [{ shotId: "web/app/home/rest/desktop/dark", hash: "h1", path: "x.png", runId: "r" }],
    ...over,
  } as BacklogFinding;
}

function cluster(members: BacklogFinding[]): FixCluster {
  return { members } as FixCluster;
}

describe("which members this run can vouch for closing", () => {
  test("a member whose own shot changed is closable", () => {
    const m = member({});
    const out = unclosableMembers(cluster([m]), new Set(["web/app/home/rest/desktop/dark"]));
    expect(out).toHaveLength(0);
  });

  test("a member none of whose shots changed is not, even when a sibling's did", () => {
    const home = member({});
    const settings = member({
      fingerprint: "fp2",
      route: "/settings",
      evidence: [{ shotId: "web/app/settings/rest/desktop/dark", hash: "h2", path: "y.png", runId: "r" }],
    });
    const out = unclosableMembers(cluster([home, settings]), new Set(["web/app/home/rest/desktop/dark"]));
    expect(out.map((m) => m.fingerprint)).toEqual(["fp2"]);
  });

  test("a shot missing from the fresh capture vouches for nothing", () => {
    const m = member({});
    expect(unclosableMembers(cluster([m]), new Set())).toHaveLength(1);
  });

  test("deterministic and code members are exempt: their oracles are measurements", () => {
    const det = member({ channel: "deterministic" });
    const code = member({ channel: "code", evidence: [] });
    expect(unclosableMembers(cluster([det, code]), new Set())).toHaveLength(0);
  });

  test("a member with no evidence shots cannot be vouched for", () => {
    const m = member({ evidence: [] });
    expect(unclosableMembers(cluster([m]), new Set(["anything"]))).toHaveLength(1);
  });
});

describe("the verdict honors it", () => {
  const base = { attempt: 1, maxAttempts: 2, changedShots: 3, stillOpen: 0, unmetCriteria: 0 };

  test("an unclosable member blocks the pass the way stillOpen does", () => {
    expect(ruleVerdict({ ...base, unclosableMembers: 1 })).toBe("still-open");
    expect(ruleVerdict({ ...base, attempt: 2, unclosableMembers: 1 })).toBe("blocked");
  });

  test("zero unclosable members changes nothing, and the field is optional", () => {
    expect(ruleVerdict({ ...base, unclosableMembers: 0 })).toBe("passed");
    expect(ruleVerdict(base)).toBe("passed");
  });
});
