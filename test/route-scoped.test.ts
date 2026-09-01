// A run scoped to one route files everything that route turned up.
//
// This went through two wrong shapes first. It stopped the judge after one
// *finding*, which is the wrong unit and did not hold anyway: batches judged in
// parallel, one batch returns several findings at once, and the deterministic
// findings never went near the judge. Then it narrowed at merge time to the
// single worst issue, which did hold, but threw away real findings lookout had
// already captured and judged.
//
// The shape that works is scoping rather than narrowing: walk a route at a
// time, stop at the first route with issues, file all of them. Nothing lookout
// did is discarded, and nothing is claimed about routes it never looked at.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBacklog, mergeLatest } from "../src/verbs/backlog.js";
import { checkBacklog, renderMarkdown } from "../src/backlog/lib.js";
import { issuesOf } from "../src/issues/registry.js";
import type { CaptureReport, ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-route-"));
  mkdirSync(join(dir, ".lookout", "evidence"), { recursive: true });
  return {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
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

describe("a route's issues are all filed", () => {
  test("every distinct root cause on the route becomes an issue", async () => {
    const r = project();
    writeReport(r, [shot("/dash", "desktop", "dark")]);
    await mergeLatest(r, {
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
    // All three, not the worst one. lookout captured and judged this route
    // already; dropping two of its findings would report it as healthier than
    // it found it, and make somebody pay to judge the same views again.
    expect(issuesOf(b)).toHaveLength(3);
  });

  test("what the checks found and what the judge found both stand", async () => {
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
    await mergeLatest(r, {
      judgeOutcome: { runId: "r1", findings: [aiFinding()] } as never,
    });
    const b = await loadBacklog(r);
    const cats = issuesOf(b)
      .map((c) => c.category)
      .sort();
    expect(cats).toEqual(["a11y", "color-scheme"]);
  });

  test("a root cause seen on several shots of the route is still one issue", async () => {
    const r = project();
    writeReport(r, [shot("/dash", "desktop", "dark"), shot("/dash", "phone", "dark")]);
    await mergeLatest(r, {
      judgeOutcome: {
        runId: "r1",
        findings: [aiFinding(), aiFinding({ shotId: "web/app/dash/rest/phone/dark" })],
      } as never,
    });
    const b = await loadBacklog(r);
    const clusters = issuesOf(b);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(2);
  });

  test("a route with nothing on it files nothing, so the walk moves on", async () => {
    const r = project();
    writeReport(r, [shot("/dash", "desktop", "dark")]);
    const merged = await mergeLatest(r, {
      judgeOutcome: { runId: "r1", findings: [] } as never,
    });
    // This is the signal the walk branches on: nothing added means try the next
    // route, rather than stopping here and calling the application clean.
    expect(merged.added + merged.reopened).toBe(0);
  });
});

describe("what lastSeen records", () => {
  test("an AI finding just re-found is not reported as drift-resolved", async () => {
    // `lastSeen` answers one question, asked by `backlog check`: which CAPTURE
    // run did this finding survive? Stamping the AI channel with the judge's own
    // run id made it unanswerable, because the two id families never match, so
    // every open AI finding the judge had just re-found came back as
    // "not re-found in run <id>; mark fixed or investigate" and the documented
    // gate failed on healthy backlogs. The fixture below is the one the old
    // tests never had: a judge run id that differs from the capture run id, the
    // way `runId("check")` and `runId("web")` always do in production.
    const r = project();
    const shots = [shot("/dash", "desktop", "dark")];
    writeReport(r, shots);
    await mergeLatest(r, {
      judgeOutcome: { runId: "check-1a2b3c", findings: [aiFinding()] } as never,
    });

    const b = await loadBacklog(r);
    const latestReport = {
      version: 1,
      project: "app",
      runs: [{ id: "r1" }],
      shots,
    } as unknown as CaptureReport;

    const problems = checkBacklog(b, { mdOnDisk: renderMarkdown(b), latestReport });
    expect(problems.map((p) => p.kind)).not.toContain("drift-resolved");
    expect(Object.values(b.findings)[0]!.lastSeen).toBe("r1");
  });
});
