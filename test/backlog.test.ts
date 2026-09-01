// Pure-function coverage of the backlog state machine: fingerprints, merge
// dedupe/reopen/suppress, status transitions with mandatory reasons, the
// check gate, and deterministic markdown rendering.
import { describe, expect, test } from "bun:test";
import {
  checkBacklog,
  deterministicToFindings,
  emptyBacklog,
  fingerprintOf,
  mergeFindings,
  renderMarkdown,
  setStatus,
  stats,
} from "../src/backlog/lib.js";
import type { CaptureReport, ShotRecord } from "../src/types.js";

const NOW = "2026-08-25T00:00:00.000Z";

function shot(id: string, findings: ShotRecord["deterministicFindings"] = []): ShotRecord {
  const [platform, target, slug, state, formFactor, scheme] = id.split("/");
  return {
    id,
    target: target!,
    route: `/${slug}`,
    routeName: slug!,
    state: state!,
    platform: platform as ShotRecord["platform"],
    formFactor: formFactor as ShotRecord["formFactor"],
    scheme: scheme as ShotRecord["scheme"],
    path: `${id}.png`,
    hash: `hash-${id}`,
    bytes: 1,
    width: 100,
    height: 100,
    animated: false,
    capturedAt: NOW,
    runId: "run-1",
    deterministicFindings: findings,
  };
}

function report(shots: ShotRecord[], runId = "run-1"): CaptureReport {
  return {
    version: 1,
    project: "test",
    createdAt: NOW,
    updatedAt: NOW,
    runs: [
      {
        id: runId,
        kind: "web",
        startedAt: NOW,
        finishedAt: NOW,
        flags: {},
        failures: [],
        skips: [],
      },
    ],
    shots,
  };
}

const overflowShot = () =>
  shot("web/app/checkout/rest/phone/dark", [
    { type: "horizontal-overflow", severity: "error", message: "page scrolls 240px sideways" },
  ]);

describe("fingerprints and deterministic mapping", () => {
  test("fingerprint is axes-only and stable", () => {
    expect(
      fingerprintOf({
        target: "app",
        route: "/checkout",
        state: "rest",
        formFactor: "phone",
        scheme: "dark",
        category: "layout-overflow",
        attribute: "horizontal-scroll",
      }),
    ).toBe("app.checkout.rest.phone.dark.layout-overflow.horizontal-scroll");
  });

  test("deterministic findings map to categories; axe keeps its ruleId; blank is critical", () => {
    const r = report([
      overflowShot(),
      shot("web/app/home/rest/desktop/dark", [
        { type: "axe-violation", severity: "warning", message: "x", meta: { ruleId: "html-has-lang" } },
        { type: "blank-shot", severity: "error", message: "blank" },
      ]),
    ]);
    const f = deterministicToFindings(r);
    expect(f.map((x) => `${x.category}/${x.attribute}/${x.severity}`).sort()).toEqual([
      "a11y/axe-html-has-lang/medium",
      "layout-overflow/horizontal-scroll/high",
      "render-failure/blank/critical",
    ]);
  });
});

describe("merge state machine", () => {
  test("add, refresh, reopen, and by-design suppression", () => {
    const b = emptyBacklog("test", NOW);
    const incoming = deterministicToFindings(report([overflowShot()]));

    const r1 = mergeFindings(b, incoming, "run-1", NOW);
    expect(r1.added.length).toBe(1);
    const fp = r1.added[0]!;

    // Same finding again: refreshed, not duplicated.
    const r2 = mergeFindings(b, incoming, "run-2", NOW);
    expect(r2.refreshed).toEqual([fp]);
    expect(Object.keys(b.findings).length).toBe(1);
    expect(b.findings[fp]!.lastSeen).toBe("run-2");

    // Fixed, then re-found: reopened with attempts preserved.
    setStatus(b, fp, "fixed", { commit: "abc1234", runId: "run-2", now: NOW });
    const r3 = mergeFindings(b, incoming, "run-3", NOW);
    expect(r3.reopened).toEqual([fp]);
    expect(b.findings[fp]!.status).toBe("open");
    expect(b.findings[fp]!.fixedIn).toBeNull();

    // By design: silently suppressed forever after.
    setStatus(b, fp, "by-design", { reason: "the demo page scrolls on purpose", runId: "run-3", now: NOW });
    const r4 = mergeFindings(b, incoming, "run-4", NOW);
    expect(r4.suppressed).toEqual([fp]);
    expect(b.findings[fp]!.status).toBe("by-design");
  });

  test("a refresh adopts a region where none was recorded, and never overwrites one", () => {
    const b = emptyBacklog("test", NOW);
    const base = deterministicToFindings(report([overflowShot()]));
    mergeFindings(b, base, "run-1", NOW);
    const fp = Object.keys(b.findings)[0]!;
    expect(b.findings[fp]!.region).toBeUndefined();

    // The question gets asked for the first time: the answer is adopted.
    const regioned = structuredClone(base);
    regioned[0]!.region = "shell-nav";
    mergeFindings(b, regioned, "run-2", NOW);
    expect(b.findings[fp]!.region).toBe("shell-nav");

    // A later, different claim does not move a recorded answer.
    const disagreeing = structuredClone(base);
    disagreeing[0]!.region = "content";
    mergeFindings(b, disagreeing, "run-3", NOW);
    expect(b.findings[fp]!.region).toBe("shell-nav");
  });

  test("new evidence hashes append, capped at 6", () => {
    const b = emptyBacklog("test", NOW);
    const base = deterministicToFindings(report([overflowShot()]));
    mergeFindings(b, base, "run-1", NOW);
    const fp = Object.keys(b.findings)[0]!;
    for (let i = 0; i < 8; i++) {
      const variant = structuredClone(base);
      variant[0]!.evidence[0]!.hash = `h${i}`;
      mergeFindings(b, variant, `run-${i + 2}`, NOW);
    }
    expect(b.findings[fp]!.evidence.length).toBe(6);
  });
});

describe("status transitions", () => {
  test("by-design and blocked demand reasons; blocked counts attempts", () => {
    const b = emptyBacklog("test", NOW);
    mergeFindings(b, deterministicToFindings(report([overflowShot()])), "run-1", NOW);
    const fp = Object.keys(b.findings)[0]!;
    expect(() => setStatus(b, fp, "by-design", { runId: "r", now: NOW })).toThrow(/reason/);
    expect(() => setStatus(b, fp, "blocked", { runId: "r", now: NOW })).toThrow(/reason/);
    setStatus(b, fp, "blocked", { reason: "needs a native fix upstream", runId: "r", now: NOW });
    expect(b.findings[fp]!.fixAttempts).toBe(1);
    expect(() => setStatus(b, "nope", "open", { runId: "r", now: NOW })).toThrow(/no finding/);
  });
});

describe("check gate", () => {
  test("flags missing reasons, stale markdown, and drift-resolved findings", () => {
    const b = emptyBacklog("test", NOW);
    mergeFindings(b, deterministicToFindings(report([overflowShot()])), "run-1", NOW);
    const fp = Object.keys(b.findings)[0]!;
    b.findings[fp]!.status = "blocked"; // sneaking past setStatus validation
    let problems = checkBacklog(b, { mdOnDisk: null, latestReport: null });
    expect(problems.some((p) => p.kind === "reason-missing")).toBe(true);

    b.findings[fp]!.status = "open";
    problems = checkBacklog(b, { mdOnDisk: "stale", latestReport: null });
    expect(problems.some((p) => p.kind === "stale-md")).toBe(true);

    // Latest run re-captured the same shot but no merge refreshed the finding.
    const latest = report([shot("web/app/checkout/rest/phone/dark")], "run-9");
    latest.shots[0]!.runId = "run-9";
    problems = checkBacklog(b, { mdOnDisk: renderMarkdown(b), latestReport: latest });
    expect(problems.some((p) => p.kind === "drift-resolved")).toBe(true);
  });
});

describe("markdown + stats", () => {
  test("deterministic render, sections by status, reasons shown", () => {
    const b = emptyBacklog("test", NOW);
    mergeFindings(b, deterministicToFindings(report([overflowShot()])), "run-1", NOW);
    const fp = Object.keys(b.findings)[0]!;
    setStatus(b, fp, "by-design", { reason: "intentional demo scroller", runId: "r", now: NOW });
    const md = renderMarkdown(b);
    expect(md).toContain("## By design");
    expect(md).toContain("intentional demo scroller");
    expect(md).toBe(renderMarkdown(b)); // stable
    expect(stats(b).byStatus["by-design"]).toBe(1);
  });
});
