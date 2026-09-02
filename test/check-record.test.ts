// What a finding keeps of the check and the capture behind it: bounded, so a
// rule that fires on a thousand elements is not a thousand lines in git, and
// carried through ingestion and re-sighting so a document can list it and
// the prose can be rewritten without a re-capture.
import { describe, expect, test } from "bun:test";
import { checkRecordOf, viewOf } from "../src/backlog/check-record.js";
import { aiToFindings, deterministicToFindings } from "../src/backlog/ingest.js";
import { mergeFindings } from "../src/backlog/merge.js";
import { emptyBacklog } from "../src/backlog/lib.js";
import type { CaptureReport, DeterministicFinding, ShotRecord } from "../src/types.js";
import type { AiFinding } from "../src/judge/engine.js";

const shot = (over: Partial<ShotRecord> = {}): ShotRecord => ({
  id: "web/app/dash/rest/phone/dark",
  target: "app",
  route: "/dash",
  routeName: "dash",
  state: "rest",
  platform: "web",
  formFactor: "phone",
  scheme: "dark",
  path: "web/app/dash/rest--phone-dark.png",
  hash: "h1",
  bytes: 1,
  width: 780,
  height: 1688,
  animated: false,
  capturedAt: "t",
  runId: "r1",
  deterministicFindings: [],
  ...over,
});

const axe = (meta: Record<string, unknown>): DeterministicFinding => ({
  type: "axe-violation",
  severity: "warning",
  message: "heading-order: Heading levels should only increase by one",
  meta: { ruleId: "heading-order", impact: "moderate", nodeCount: 2, targets: ["#a", "#b"], ...meta },
});

describe("the check's record, bounded", () => {
  test("strings are cut at 400, lists at 20, nesting at two levels, and the provenance join is left out", () => {
    const c = checkRecordOf(
      axe({
        description: "x".repeat(500),
        targets: Array.from({ length: 30 }, (_, i) => `#n${i}`),
        nodes: [{ target: "#a", checks: [{ id: "c", message: "m", deeper: { gone: true } }] }],
        provenance: [{ component: "X", file: null, line: null, selector: "#a", cssPath: "#a" }],
      }),
    );
    expect(c.type).toBe("axe-violation");
    expect((c.meta!.description as string).length).toBe(400);
    expect((c.meta!.targets as string[]).length).toBe(20);
    expect(c.meta!.provenance).toBeUndefined();
    // Two levels down survive; a third is dropped rather than serialised.
    expect((c.meta!.nodes as { checks: { id: string; message?: string; deeper?: unknown }[] }[])[0]!.checks[0]).toEqual({ id: "c", message: "m" });
    expect(c.meta!.ruleId).toBe("heading-order");
  });

  test("a check with no meta keeps only its type", () => {
    expect(checkRecordOf({ type: "page-error", severity: "error", message: "boom" })).toEqual({ type: "page-error" });
  });

  test("the view facts are whatever the shot recorded, and nothing when it recorded none", () => {
    expect(viewOf(shot())).toEqual({});
    expect(viewOf(shot({ design: "/d.png", designHash: "d1", provenance: "p.json", viewport: { width: 390, height: 844 } }))).toEqual({
      view: { design: "/d.png", designHash: "d1", provenance: "p.json", viewport: { width: 390, height: 844 } },
    });
  });
});

describe("carried through ingestion", () => {
  test("a deterministic finding keeps the check and the view", () => {
    const report = { version: 1, project: "app", createdAt: "t", updatedAt: "t", runs: [],
      shots: [shot({ design: "/d.png", deterministicFindings: [axe({ helpUrl: "https://x" })] })] } as unknown as CaptureReport;
    const [f] = deterministicToFindings(report);
    expect(f!.check).toEqual({ type: "axe-violation", meta: { ruleId: "heading-order", impact: "moderate", nodeCount: 2, targets: ["#a", "#b"], helpUrl: "https://x" } });
    expect(f!.view).toEqual({ design: "/d.png" });
  });

  test("a judged finding keeps the verifier's note, bounded, and the view", () => {
    const ai = { shotId: "web/app/dash/rest/phone/dark", category: "contrast", attribute: "body-text", severity: "high", title: "t",
      problem: "p", expected: "e", observed: "o", confidence: "high", acceptance: [], verified: true,
      verifierNote: "the text is visibly faint against the card ".repeat(12) } as unknown as AiFinding & { verified: boolean; verifierNote: string };
    const [f] = aiToFindings([ai], new Map([[ai.shotId, shot({ provenance: "p.json" })]]));
    expect(f!.verifierNote!.length).toBe(300);
    expect(f!.view).toEqual({ provenance: "p.json" });
    const [bare] = aiToFindings([{ ...ai, verifierNote: undefined }], new Map([[ai.shotId, shot()]]));
    expect(bare!.verifierNote).toBeUndefined();
    expect(bare!.view).toBeUndefined();
  });
});

describe("refreshed on re-sighting, never cleared", () => {
  test("a newer sighting replaces them; one without them leaves them alone", () => {
    const b = emptyBacklog("app", "t");
    const report = (df: DeterministicFinding, design?: string) =>
      ({ version: 1, project: "app", createdAt: "t", updatedAt: "t", runs: [], shots: [shot({ ...(design ? { design } : {}), hash: design ? "h2" : "h1", deterministicFindings: [df] })] }) as unknown as CaptureReport;
    mergeFindings(b, deterministicToFindings(report(axe({ nodeCount: 2 }), "/d1.png")), "r1", "t1");
    const fp = Object.keys(b.findings)[0]!;
    expect(b.findings[fp]!.check!.meta!.nodeCount).toBe(2);
    expect(b.findings[fp]!.view).toEqual({ design: "/d1.png" });
    mergeFindings(b, deterministicToFindings(report(axe({ nodeCount: 5 }), "/d2.png")), "r2", "t2");
    expect(b.findings[fp]!.check!.meta!.nodeCount).toBe(5);
    expect(b.findings[fp]!.view).toEqual({ design: "/d2.png" });
    const stripped = deterministicToFindings(report(axe({ nodeCount: 7 }))).map((f) => ({ ...f, check: undefined, view: undefined }));
    mergeFindings(b, stripped, "r3", "t3");
    expect(b.findings[fp]!.check!.meta!.nodeCount).toBe(5);
    expect(b.findings[fp]!.view).toEqual({ design: "/d2.png" });
  });
});
