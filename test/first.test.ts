// The --first walk's order and honesty rules. The walk itself runs through
// runCheck (composition exercised against a served fixture); what is pinned
// here is the pure ordering and the bounded placement option.
import { describe, expect, test } from "bun:test";
import { orderStops } from "../src/check/first.js";

const stop = (route: string, target = "app") => ({ target, route });

describe("the walk order", () => {
  test("routes with open findings come first, worst severity first", () => {
    const stops = [stop("/a"), stop("/b"), stop("/c"), stop("/d")];
    const open = [
      { target: "app", route: "/c", severity: "high", status: "open", channel: "ai" },
      { target: "app", route: "/d", severity: "critical", status: "open", channel: "ai" },
    ] as never[];
    expect(orderStops(stops, open).map((s) => s.route)).toEqual(["/d", "/c", "/a", "/b"]);
  });

  test("routes ruled fully fixed walk before everything, open work included", () => {
    // A fix in one area can regress another, and this walk runs between every
    // fix attempt. If fixed routes waited behind the open band, the stop rule
    // would end the run before reaching them for as long as any open work
    // stands, which is the whole campaign: "always re-tested" has to mean
    // ahead of the stop, not behind it.
    const stops = [stop("/a"), stop("/b"), stop("/c")];
    const findings = [
      { target: "app", route: "/b", severity: "high", status: "open", channel: "ai" },
      { target: "app", route: "/c", severity: "critical", status: "fixed", channel: "ai" },
    ] as never[];
    expect(orderStops(stops, findings).map((s) => s.route)).toEqual(["/c", "/b", "/a"]);
  });

  test("open or blocked work on a route keeps it out of the fixed band", () => {
    // "Everything has been fixed" is the band's admission rule. A route still
    // carrying open work walks with the open band; one carrying blocked work
    // is a person's, and walking it first would stop every run at the same
    // un-dispatchable issue.
    const stops = [stop("/a"), stop("/b"), stop("/c")];
    const findings = [
      { target: "app", route: "/b", severity: "critical", status: "fixed", channel: "ai" },
      { target: "app", route: "/b", severity: "high", status: "open", channel: "ai" },
      { target: "app", route: "/c", severity: "critical", status: "fixed", channel: "ai" },
      { target: "app", route: "/c", severity: "high", status: "blocked", channel: "ai" },
    ] as never[];
    expect(orderStops(stops, findings).map((s) => s.route)).toEqual(["/b", "/a", "/c"]);
  });

  test("by-design, code-channel and off-walk findings do not reorder anything", () => {
    const stops = [stop("/a"), stop("/b")];
    const findings = [
      { target: "app", route: "/b", severity: "critical", status: "by-design", channel: "ai" },
      { target: "app", route: "/b", severity: "critical", status: "fixed", channel: "code" },
      { target: "app", route: "/b", severity: "critical", status: "open", channel: "code" },
      { target: "other", route: "/b", severity: "critical", status: "fixed", channel: "ai" },
      { target: "other", route: "/b", severity: "critical", status: "open", channel: "ai" },
    ] as never[];
    expect(orderStops(stops, findings).map((s) => s.route)).toEqual(["/a", "/b"]);
  });

  test("a clean backlog leaves config order untouched", () => {
    const stops = [stop("/z"), stop("/a")];
    expect(orderStops(stops, []).map((s) => s.route)).toEqual(["/z", "/a"]);
  });
});

describe("placement bounded to named issues", () => {
  test("only the named ids are considered; the rest wait for a full check", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const { reconcileIssues } = await import("../src/issues/registry.js");
    const { tmpProject } = await import("./tmp-project.js");
    const { join } = await import("node:path");
    const finding = (fp: string, attr: string) => ({
      fingerprint: fp, target: "app", route: `/${fp}`, state: "rest",
      platform: "web", formFactor: "desktop", scheme: "dark",
      category: "contrast", attribute: attr, severity: "high", status: "open",
      reason: null, title: "t", problem: "p", expected: "e", observed: "o",
      channel: "ai", confidence: "high", verified: true, evidence: [],
      firstSeen: "r", lastSeen: "r", fixAttempts: 0, fixedIn: null,
    });
    const backlog = {
      note: "", project: "demo", updatedAt: "now",
      findings: { one: finding("one", "a"), two: finding("two", "b") },
      issues: {},
    } as never;
    reconcileIssues(backlog, "now");
    const issues = (backlog as { issues: Record<string, { placement?: unknown }> }).issues;
    const ids = Object.keys(issues);
    const inv = {
      schema: 2, at: "now", project: "demo",
      kits: [{ id: "@acme/kit", name: "@acme/kit", via: "dependency", evidence: [],
        editable: true, packageRoot: null, componentRoots: ["/repo/atoms"], importPrefixes: [], exports: [] }],
      tokens: [], appRoots: [], handRolls: [], adoption: null, notes: [],
    } as never;
    const before = process.env.LOOKOUT_CLAUDE_BIN;
    process.env.LOOKOUT_CLAUDE_BIN = join(import.meta.dir, "mock-claude.ts");
    try {
      const run = await placeNewIssues(tmpProject("lookout-first-place-"), backlog as never, inv, {
        only: [ids[0]!],
      });
      expect(run.placed).toBe(1);
      expect(issues[ids[0]!]!.placement).toBeDefined();
      expect(issues[ids[1]!]!.placement).toBeUndefined();
      // Not "beyond the cap": the second issue was out of scope, not skipped.
      expect(run.skipped).toBe(0);
    } finally {
      if (before === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
      else process.env.LOOKOUT_CLAUDE_BIN = before;
    }
  });
});
