// Asking for one issue has to give exactly one issue.
//
// The first attempt at this stopped the judge after one *finding*, which is not
// the same thing and did not hold anyway: two batches judged in parallel so a
// second one's findings landed after the limit was met, a single batch can
// return several findings at once, and the deterministic findings were merged
// in full regardless of any of it. A click could produce fifteen issues.
//
// One issue is one cluster, not one finding: a root cause seen on six
// screenshots is one thing to fix.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeLatest } from "../src/verbs/backlog.js";
import { clusterFindings } from "../src/fix/cluster.js";
import { loadBacklog } from "../src/verbs/backlog.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-first-"));
  mkdirSync(join(dir, ".lookout", "evidence"), { recursive: true });
  return {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, ".lookout/config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
}

function shot(route: string, formFactor: string, scheme: string, det: unknown[] = []) {
  return {
    id: `web/app${route}/rest/${formFactor}/${scheme}`,
    runId: "r1",
    target: "app",
    route,
    routeName: route.slice(1),
    state: "rest",
    platform: "web",
    formFactor,
    scheme,
    path: `web/app${route}/rest--${formFactor}-${scheme}.png`,
    hash: `${route}-${formFactor}-${scheme}`,
    animated: false,
    deterministicFindings: det,
  };
}

/** A capture report on disk, which is what mergeLatest reads. */
function writeReport(r: ResolvedConfig, shots: unknown[]): void {
  writeFileSync(
    join(r.projectDir, ".lookout", "evidence", "capture-report.json"),
    JSON.stringify({
      version: 1,
      project: "app",
      runs: [{ id: "r1", startedAt: new Date(0).toISOString() }],
      shots,
      failures: [],
    }),
  );
}

function aiFinding(over: Record<string, unknown> = {}) {
  return {
    shotId: "web/app/dash/rest/desktop/dark",
    category: "color-scheme",
    attribute: "theme-not-applied",
    severity: "high",
    title: "Dark scheme renders light surfaces",
    problem: "p",
    expected: "e",
    observed: "o",
    confidence: "high",
    verified: true,
    ...over,
  };
}

describe("one issue means one cluster", () => {
  test("several findings sharing a root cause stay together as that one issue", async () => {
    const r = project();
    writeReport(r, [
      shot("/dash", "desktop", "dark"),
      shot("/dash", "phone", "dark"),
    ]);
    const merged = await mergeLatest(r, {
      firstIssueOnly: true,
      judgeOutcome: {
        runId: "r1",
        findings: [
          aiFinding(),
          // Same category and attribute on another screenshot: one root cause.
          aiFinding({ shotId: "web/app/dash/rest/phone/dark" }),
        ],
      } as never,
    });
    const b = await loadBacklog(r);
    const clusters = clusterFindings(Object.values(b.findings));
    expect(clusters).toHaveLength(1);
    // Both screenshots are kept: they are evidence for the same fix.
    expect(clusters[0]!.members).toHaveLength(2);
    expect(merged.dropped).toBe(0);
  });

  test("findings from other root causes are dropped, and counted", async () => {
    const r = project();
    writeReport(r, [shot("/dash", "desktop", "dark")]);
    const merged = await mergeLatest(r, {
      firstIssueOnly: true,
      judgeOutcome: {
        runId: "r1",
        findings: [
          aiFinding({ severity: "medium", attribute: "surface-missing" }),
          aiFinding({ severity: "critical", attribute: "theme-not-applied" }),
          aiFinding({ severity: "low", attribute: "border-faint" }),
        ],
      } as never,
    });
    const b = await loadBacklog(r);
    expect(clusterFindings(Object.values(b.findings))).toHaveLength(1);
    // The worst one is the one worth handing over.
    expect(Object.values(b.findings)[0]!.severity).toBe("critical");
    // And lookout says what it saw and did not file, rather than reporting the
    // application as healthier than it is.
    expect(merged.dropped).toBe(2);
  });

  test("a capture finding and a judged one are narrowed together, not separately", async () => {
    const r = project();
    writeReport(r, [
      shot("/dash", "desktop", "dark", [
        {
          type: "axe-violation",
          severity: "error",
          message: "Button has no accessible name",
          meta: { ruleId: "button-name" },
        },
      ]),
    ]);
    const merged = await mergeLatest(r, {
      firstIssueOnly: true,
      judgeOutcome: { runId: "r1", findings: [aiFinding()] } as never,
    });
    const b = await loadBacklog(r);
    // The bug this pins: deterministic findings used to be merged in full
    // whatever the judge did, so "one issue" quietly filed every axe violation
    // as well. Both channels go through the same narrowing now.
    const clusters = clusterFindings(Object.values(b.findings));
    expect(clusters).toHaveLength(1);
    expect(merged.dropped).toBe(1);
  });

  test("without the flag every finding is filed, as before", async () => {
    const r = project();
    writeReport(r, [shot("/dash", "desktop", "dark")]);
    const merged = await mergeLatest(r, {
      judgeOutcome: {
        runId: "r1",
        findings: [
          aiFinding({ attribute: "theme-not-applied" }),
          aiFinding({ attribute: "surface-missing" }),
          aiFinding({ attribute: "border-faint" }),
        ],
      } as never,
    });
    const b = await loadBacklog(r);
    expect(clusterFindings(Object.values(b.findings))).toHaveLength(3);
    expect(merged.dropped).toBe(0);
  });

  test("a run that found nothing files nothing and drops nothing", async () => {
    const r = project();
    writeReport(r, [shot("/dash", "desktop", "dark")]);
    const merged = await mergeLatest(r, {
      firstIssueOnly: true,
      judgeOutcome: { runId: "r1", findings: [] } as never,
    });
    expect(merged.added).toBe(0);
    expect(merged.dropped).toBe(0);
  });
});
