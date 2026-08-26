// Auto-mode tests: root-cause clustering, brief rendering, and the dispatch
// plan an orchestrating session reads.
import { describe, expect, test } from "bun:test";
import { clusterFindings, clusterIdOf, clusterScope, slug } from "../src/fix/cluster.js";
import { renderBrief } from "../src/fix/brief.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import type { ResolvedConfig } from "../src/types.js";

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  const route = over.route ?? "/login";
  const formFactor = over.formFactor ?? "desktop";
  const scheme = over.scheme ?? "light";
  return {
    fingerprint: `app.${route}.rest.${formFactor}.${scheme}.color-scheme.theme-not-switching`,
    target: "app",
    route,
    state: "rest",
    platform: "web",
    formFactor,
    scheme,
    category: "color-scheme",
    attribute: "theme-not-switching",
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
    // One shot id per route+formFactor+scheme, as capture produces: several
    // findings on one screenshot must share it.
    evidence: [
      {
        shotId: `web/app${route}/rest/${formFactor}/${scheme}`,
        path: `web/app${route}/rest/${formFactor}/${scheme}.png`,
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

const resolved = {
  config: {} as ResolvedConfig["config"],
  configPath: "/repo/.lookout/config.ts",
  projectDir: "/repo",
  project: "proj",
} as ResolvedConfig;

describe("cluster ids", () => {
  test("slug is filename and argv safe", () => {
    expect(slug("Color Scheme/Not Switching!")).toBe("color-scheme-not-switching");
  });

  test("id derives from target, category and attribute alone, so it is stable", () => {
    const a = clusterIdOf(finding({ route: "/login" }));
    const b = clusterIdOf(finding({ route: "/settings" }));
    expect(a).toBe(b);
    expect(a).toBe("app--color-scheme--theme-not-switching");
  });
});

describe("clusterFindings", () => {
  test("one root cause across many shots and routes becomes one unit of work", () => {
    const findings = ["/login", "/settings", "/home"].flatMap((route) =>
      ["desktop", "phone"].map((ff) => finding({ route, formFactor: ff as BacklogFinding["formFactor"] })),
    );
    const clusters = clusterFindings(findings);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.shotCount).toBe(6);
    expect(clusters[0]!.routes).toEqual(["/home", "/login", "/settings"]);
    expect(clusterScope(clusters[0]!)).toEqual({ targets: ["app"], routes: ["/home", "/login", "/settings"] });
  });

  test("different attributes stay separate units of work", () => {
    const clusters = clusterFindings([
      finding(),
      finding({ fingerprint: "x", category: "spacing", attribute: "button-gap", severity: "medium" }),
    ]);
    expect(clusters.length).toBe(2);
  });

  test("worst severity first, then broadest blast radius", () => {
    const clusters = clusterFindings([
      finding({ fingerprint: "a", category: "spacing", attribute: "gap", severity: "high" }),
      finding({ fingerprint: "b", severity: "critical" }),
      finding({ fingerprint: "c", route: "/two", severity: "critical" }),
    ]);
    expect(clusters[0]!.severity).toBe("critical");
    expect(clusters[0]!.shotCount).toBe(2);
    expect(clusters[1]!.severity).toBe("high");
  });

  test("severity floor, status filter and attempt cap all narrow the dispatch", () => {
    const set = [
      finding({ fingerprint: "a", severity: "low" }),
      finding({ fingerprint: "b", category: "spacing", attribute: "gap", severity: "high" }),
      finding({ fingerprint: "c", category: "contrast", attribute: "body", severity: "high", status: "by-design" }),
      finding({ fingerprint: "d", category: "a11y", attribute: "target", severity: "high", fixAttempts: 2 }),
    ];
    const clusters = clusterFindings(set, { minSeverity: "high", maxAttempts: 2 });
    expect(clusters.map((c) => c.attribute)).toEqual(["gap"]);
  });
});

describe("co-located accessibility violations", () => {
  function axe(rule: string, route = "/identities"): BacklogFinding {
    return finding({
      fingerprint: `app.${route}.${rule}`,
      route,
      category: "a11y",
      attribute: `axe-${rule}`,
      channel: "deterministic",
      title: `${rule} violation`,
      problem: `${rule}: the widget is malformed`,
      expected: "",
      observed: "",
    });
  }

  test("rules firing on one route group into a single unit of work", () => {
    const clusters = clusterFindings([
      axe("aria-required-children"),
      axe("aria-required-parent"),
      axe("nested-interactive"),
      axe("button-name"),
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.id).toBe("app--identities--a11y");
    expect(clusters[0]!.defects.length).toBe(4);
    // Four rules, one screenshot: the brief must not list it four times.
    expect(clusters[0]!.shotCount).toBe(1);
    expect(clusters[0]!.findingCount).toBe(4);
    expect(clusters[0]!.title).toBe("4 a11y defects on /identities");
  });

  test("different routes stay separate, since they are different components", () => {
    const clusters = clusterFindings([axe("document-title", "/dashboard"), axe("button-name", "/identities")]);
    expect(clusters.length).toBe(2);
  });

  test("a judged a11y finding still clusters by its described attribute", () => {
    const judged = finding({ category: "a11y", attribute: "touch-target-size", channel: "ai" });
    expect(clusterIdOf(judged)).toBe("app--a11y--touch-target-size");
  });

  test("the brief lists every grouped defect, not just the worst", () => {
    const cluster = clusterFindings([axe("button-name"), axe("nested-interactive")])[0]!;
    const md = renderBrief(cluster, { resolved, attempt: 1, maxAttempts: 2, priorAttempts: [] });
    expect(md).toContain("2 reported defects");
    expect(md.match(/^- \/repo\/.lookout/gm)?.length).toBe(1);
    expect(md).toContain("axe-button-name");
    expect(md).toContain("axe-nested-interactive");
    expect(md).toContain("All of them must be gone");
    expect(md).toContain("## What the checks found");
  });
});

describe("renderBrief", () => {
  const cluster = clusterFindings([finding(), finding({ fingerprint: "b", route: "/settings" })])[0]!;

  test("carries the repo, the evidence paths and the reply contract", () => {
    const md = renderBrief(cluster, { resolved, attempt: 1, maxAttempts: 2, priorAttempts: [] });
    expect(md).toContain("repository: /repo");
    expect(md).toContain("/repo/.lookout/evidence/web/app/login/rest/desktop/light.png");
    // Two members, two routes, two distinct screenshots: each listed once.
    expect(md.match(/^- \/repo\/.lookout/gm)?.length).toBe(2);
    expect(md).toContain('"outcome": "fixed" | "not-code-fixable" | "gave-up"');
    expect(md).toContain("Do not run lookout, and do not judge your own work");
    expect(md).toContain("2 routes");
  });

  test("a second attempt carries what was tried and what the judge still saw", () => {
    const md = renderBrief(cluster, {
      resolved,
      attempt: 2,
      maxAttempts: 2,
      priorAttempts: [
        {
          n: 1,
          dispatchedAt: "2026-08-26T00:00:00Z",
          reported: { commit: "abc1234", note: "swapped the token" },
          verdict: "still-open",
          judgeNote: "the card is still dark in the light capture",
        },
      ],
    });
    expect(md).toContain("Attempt 1 did not fix this");
    expect(md).toContain("swapped the token");
    expect(md).toContain("the card is still dark in the light capture");
    expect(md).toContain("Do not repeat the previous approach");
  });
});
