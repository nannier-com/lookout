// Pure-function coverage of the backlog state machine: fingerprints, merge
// dedupe/reopen/suppress, status transitions with mandatory reasons, the
// check gate, and deterministic markdown rendering.
import { describe, expect, test } from "bun:test";
import { reconcileIssues } from "../src/issues/registry.js";
import {
  aiToFindings,
  checkBacklog,
  deterministicToFindings,
  emptyBacklog,
  failing,
  fingerprintOf,
  mergeFindings,
  renderMarkdown,
  setStatus,
  stats,
} from "../src/backlog/lib.js";
import type { AiFinding } from "../src/judge/engine.js";
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

  test("a clip keeps the kind of box that clipped it, and its region when every offender agrees", () => {
    const clip = (offenders: { path: string; clipperPath: string }[], clipper = "ancestor") => ({
      type: "edge-clipped" as const,
      severity: "error" as const,
      message: "content is cut off",
      meta: { clipper, clipped: offenders.length, offenderPath: offenders[0]!.path, offenders },
    });
    // Two clips of the same kind on one shot are one finding by construction
    // (the check files one per kind), so what varies here is only the region.
    const inHeader = deterministicToFindings(
      report([shot("web/app/home/rest/phone/dark", [clip([{ path: "#acct", clipperPath: "header" }])])]),
    );
    // The offender's own path stops at its id and says nothing about ancestry;
    // the box that clipped it is the header, and that is what decides.
    expect(inHeader[0]!.attribute).toBe("edge-clipped-ancestor");
    expect(inHeader[0]!.category).toBe("layout-overflow");
    expect(inHeader[0]!.region).toBe("shell-header");

    // A viewport clip keeps its own attribute: content lost to the window and
    // content lost inside a box are different fixes.
    const atViewport = deterministicToFindings(
      report([shot("web/app/home/rest/phone/dark", [clip([{ path: "main > div", clipperPath: "" }], "viewport")])]),
    );
    expect(atViewport[0]!.attribute).toBe("edge-clipped-viewport");
    expect(atViewport[0]!.region).toBeUndefined();

    // Offenders in different places name no single region, and the safe answer
    // is none: a shell region is identity, and there is no judge here to
    // overrule a wrong one.
    const mixed = deterministicToFindings(
      report([
        shot("web/app/home/rest/phone/dark", [
          clip([
            { path: "#acct", clipperPath: "header" },
            { path: "div:nth-of-type(3) > p", clipperPath: "div:nth-of-type(3)" },
          ]),
        ]),
      ]),
    );
    expect(mixed[0]!.region).toBeUndefined();
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

  test("the judge stamp rides ingestion and follows the newest sighting", () => {
    const s = shot("web/app/checkout/rest/phone/dark");
    const ai = (judge?: string): AiFinding & { verified?: boolean } =>
      ({
        shotId: s.id, category: "contrast", attribute: "body-text",
        region: "content", severity: "high", title: "t", problem: "p",
        expected: "e", observed: "o", confidence: "high",
        acceptance: ["Body copy reads at 4.5:1 or better."],
        ...(judge ? { judge } : {}),
      }) as AiFinding;
    const shotsById = new Map([[s.id, s]]);

    const b = emptyBacklog("test", NOW);
    mergeFindings(b, aiToFindings([ai("judge-visibility")], shotsById, {}), "run-1", NOW);
    const fp = Object.keys(b.findings)[0]!;
    expect(b.findings[fp]!.judge).toBe("judge-visibility");
    // The fingerprint carries no judge term: the stamp is metadata, not identity.
    expect(fp).not.toContain("judge-visibility");

    // A stampless re-sighting (an old report replayed) keeps the stamp...
    mergeFindings(b, aiToFindings([ai()], shotsById, {}), "run-2", NOW);
    expect(b.findings[fp]!.judge).toBe("judge-visibility");
    // ...and a newer stamp wins, so a re-partition follows the current owner.
    mergeFindings(b, aiToFindings([ai("judge-craft")], shotsById, {}), "run-3", NOW);
    expect(b.findings[fp]!.judge).toBe("judge-craft");

    const schemaProblems = (): number =>
      checkBacklog(b, { mdOnDisk: null, latestReport: null }).filter((p) => p.kind === "schema").length;
    expect(schemaProblems()).toBe(0);
    b.findings[fp]!.judge = "" as never;
    expect(schemaProblems()).toBe(1);
  });

  test("a panel-scoped run does not read as drift for the lanes it skipped", () => {
    const b = emptyBacklog("test", NOW);
    const s = shot("web/app/checkout/rest/phone/dark");
    b.findings["ai.fp"] = {
      fingerprint: "ai.fp", target: "app", route: "/checkout", state: "rest",
      platform: "web", formFactor: "phone", scheme: "dark",
      category: "contrast", attribute: "body-text", severity: "high",
      status: "open", reason: null, title: "t", problem: "p", expected: "e",
      observed: "o", channel: "ai", confidence: "high", verified: true,
      evidence: [{ shotId: s.id, path: "x.png", hash: "h", runId: "run-1" }],
      firstSeen: "run-1", lastSeen: "run-1", fixAttempts: 0, fixedIn: null,
    } as never;
    const latest = report([s], "run-9");
    latest.shots[0]!.runId = "run-9";
    const drift = (judgedPanels: readonly string[] | null): boolean =>
      checkBacklog(b, { mdOnDisk: null, latestReport: latest, judgedPanels })
        .some((p) => p.kind === "drift-resolved");

    // judge-visibility owns contrast; when it sat the run out, silence about
    // this finding proves nothing.
    expect(drift(["judge-craft"])).toBe(false);
    // Asked and still not re-found: that is drift.
    expect(drift(["judge-visibility"])).toBe(true);
    // A caller without a judge report flags exactly as before.
    expect(drift(null)).toBe(true);
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
    // The rows read as words; the fingerprint sits once under Identities,
    // and the issue number links to the document that carries the rest.
    expect(md).toContain("| issue | severity | channel | title | evidence |");
    expect(md).not.toContain("| fingerprint |");
    expect(md).toContain("## Identities");
    expect(md).toBe(renderMarkdown(b)); // stable
    reconcileIssues(b, NOW);
    const id = Object.keys(b.issues)[0]!;
    const linked = renderMarkdown(b);
    expect(linked).toContain(`| [${id}](issues/${id}/Issue.md) | high |`);
    expect(linked).toContain(`- [${id}](issues/${id}/Issue.md) \`${fp}\``);
    expect(stats(b).byStatus["by-design"]).toBe(1);
  });
});

describe("a problem written for one reader", () => {
  test("is a warning that does not fail the check unless strict", () => {
    const b = emptyBacklog("test", NOW);
    mergeFindings(b, deterministicToFindings(report([overflowShot()])), "run-1", NOW);
    reconcileIssues(b, NOW);
    const fp = Object.keys(b.findings)[0]!;
    b.findings[fp]!.problem = b.findings[fp]!.title;
    const problems = checkBacklog(b, { mdOnDisk: renderMarkdown(b), latestReport: null });
    expect(problems.map((p) => [p.kind, p.level])).toEqual([["problem-unexplained", "warning"]]);
    expect(problems[0]!.message).toBe("problem is written for one reader (title-again)");
    expect(failing(problems)).toEqual([]);
    expect(failing(problems, true)).toEqual(problems);
  });
});
