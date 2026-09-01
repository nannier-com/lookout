// Issue-level adjudication, its inheritance, and the shell verify scope.
import { describe, expect, test } from "bun:test";
import { setIssueStatus, inheritedByDesign } from "../src/backlog/adjudicate.js";
import { emptyBacklog, mergeFindings, type BacklogFinding } from "../src/backlog/lib.js";
import { reconcileIssues } from "../src/issues/registry.js";
import { clusterFindings, clusterKeyOf, clusterScope, SHELL_MAX_ROUTES } from "../src/fix/cluster.js";

const NOW = "2026-09-01T00:00:00.000Z";

function finding(over: Partial<BacklogFinding>): BacklogFinding {
  return {
    fingerprint: "app.root.rest.phone.dark.contrast.body-text",
    target: "app",
    route: "/",
    state: "rest",
    platform: "web",
    formFactor: "phone",
    scheme: "dark",
    category: "contrast",
    attribute: "body-text",
    severity: "high",
    status: "open",
    reason: null,
    title: "t",
    problem: "p",
    expected: "e",
    observed: "o",
    channel: "ai",
    confidence: "high",
    verified: true,
    acceptance: [],
    evidence: [{ shotId: "s", path: "p.png", hash: "h", runId: "web-20260801-090000" }],
    firstSeen: "web-20260801-090000",
    lastSeen: "web-20260801-090000",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  };
}

describe("setIssueStatus", () => {
  test("fans the ruling across every member and stamps the issue durably", () => {
    const b = emptyBacklog("test", NOW);
    const a = finding({});
    const c = finding({
      fingerprint: "app.root.rest.desktop.dark.contrast.body-text",
      formFactor: "desktop",
    });
    b.findings[a.fingerprint] = a;
    b.findings[c.fingerprint] = c;
    reconcileIssues(b, NOW);
    const issue = Object.values(b.issues)[0]!;

    const { fingerprints } = setIssueStatus(b, issue.id, "by-design", {
      reason: "intended density",
      runId: "manual",
      now: NOW,
    });
    expect(fingerprints.sort()).toEqual([a.fingerprint, c.fingerprint].sort());
    expect(b.findings[a.fingerprint]!.status).toBe("by-design");
    expect(b.findings[c.fingerprint]!.status).toBe("by-design");
    expect(issue.byDesign).toEqual({ reason: "intended density", at: NOW });

    // Reopening the issue clears the durable ruling with it.
    setIssueStatus(b, issue.id, "open", { runId: "manual", now: NOW });
    expect(issue.byDesign).toBeUndefined();
    expect(b.findings[a.fingerprint]!.status).toBe("open");
  });

  test("an unknown issue or an empty one refuses", () => {
    const b = emptyBacklog("test", NOW);
    expect(() => setIssueStatus(b, "123456", "by-design", { reason: "r", runId: "m", now: NOW })).toThrow(
      /no issue/,
    );
  });
});

describe("inheritance", () => {
  test("a future sibling under a by-design issue is born ruled, visibly", () => {
    const b = emptyBacklog("test", NOW);
    const a = finding({});
    b.findings[a.fingerprint] = a;
    reconcileIssues(b, NOW);
    const issue = Object.values(b.issues)[0]!;
    setIssueStatus(b, issue.id, "by-design", { reason: "intended", runId: "m", now: NOW });

    // A never-seen form factor of the same root cause arrives.
    const sibling = finding({
      fingerprint: "app.root.rest.tablet.dark.contrast.body-text",
      formFactor: "tablet",
    });
    expect(inheritedByDesign(b, sibling)?.reason).toBe("intended");
    const res = mergeFindings(b, [sibling], "web-20260901-100000", NOW);
    expect(res.suppressed).toEqual([sibling.fingerprint]);
    expect(res.added).toEqual([]);
    const rec = b.findings[sibling.fingerprint]!;
    expect(rec.status).toBe("by-design");
    expect(rec.reason).toContain("inherited from issue " + issue.id);
  });
});

describe("clusterScope for a shell cluster", () => {
  const shellFinding = (routes: string[]) =>
    finding({
      fingerprint: "app.@shell-nav.rest.phone.dark.contrast.body-text",
      region: "shell-nav",
      seenRoutes: routes,
      route: routes[0] ?? "/",
    });

  const clusterOf = (f: BacklogFinding) => {
    const key = clusterKeyOf(f);
    return clusterFindings([f], { issueIds: { [key]: "123456" } })[0]!;
  };

  test("a one-route shell cluster is topped up from config order to the floor", () => {
    const c = clusterOf(shellFinding(["/dashboard"]));
    const scope = clusterScope(c, ["/dashboard", "/identities", "/settings"]);
    expect(scope.routes).toEqual(["/dashboard", "/identities"]);
  });

  test("a wide shell cluster is capped", () => {
    const c = clusterOf(shellFinding(["/a", "/b", "/c", "/d", "/e"]));
    const scope = clusterScope(c, []);
    expect(scope.routes.length).toBe(SHELL_MAX_ROUTES);
  });

  test("a content cluster keeps today's scope exactly", () => {
    const c = clusterOf(finding({}));
    expect(clusterScope(c, ["/x", "/y"])).toEqual({ targets: ["app"], routes: ["/"] });
  });
});
