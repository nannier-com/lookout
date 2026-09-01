// Signal identity and the learned-from watermark: the same event recomputes
// to the same key, attribution follows who erred, and an improve consumes
// what it was shown so identical evidence never pays twice.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gatherSignals } from "../src/skills/signals.js";
import { loadWatermark, newSignals, stampSeen } from "../src/skills/watermark.js";
import { evidenceDir } from "../src/config.js";
import { saveBacklog } from "../src/verbs/backlog.js";
import { nowIso } from "../src/util.js";
import { tmpProject } from "./tmp-project.js";
import type { Backlog, BacklogFinding } from "../src/backlog/lib.js";

function finding(over: Partial<BacklogFinding>): BacklogFinding {
  return {
    fingerprint: "fp1", target: "app", route: "/a", state: "rest",
    platform: "web", formFactor: "desktop", scheme: "dark",
    category: "contrast", attribute: "x", severity: "high",
    status: "open", reason: null, title: "t", problem: "p",
    expected: "e", observed: "o", channel: "ai", confidence: "high",
    verified: false, evidence: [], firstSeen: "r", lastSeen: "r",
    fixAttempts: 0, fixedIn: null,
    ...over,
  } as BacklogFinding;
}

async function projectWith(findings: BacklogFinding[]) {
  const r = tmpProject("lookout-mark-");
  const backlog: Backlog = {
    note: "", project: r.project, updatedAt: nowIso(),
    findings: Object.fromEntries(findings.map((f) => [f.fingerprint, f])),
    issues: {},
  };
  await saveBacklog(r, backlog);
  return r;
}

describe("signal identity and attribution", () => {
  test("keys are stable across recomputation and ignore the skill", async () => {
    const r = await projectWith([
      finding({ status: "by-design", reason: "intended", verified: false }),
    ]);
    const a = await gatherSignals(r);
    const b = await gatherSignals(r);
    expect(a[0]!.key).toBe(b[0]!.key);
    expect(a[0]!.key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a refuted-finding signal follows the report's judge stamp, and an old report teaches the core", async () => {
    const r = await projectWith([]);
    mkdirSync(evidenceDir(r), { recursive: true });
    writeFileSync(
      join(evidenceDir(r), "judge-report.json"),
      JSON.stringify({
        runId: "run-1",
        refuted: [
          { title: "stamped", shotId: "s1", verifierNote: "n", judge: "judge-geometry" },
          // The pre-stamp report format: no judge field at all.
          { title: "legacy", shotId: "s2", verifierNote: "n" },
        ],
      }),
    );
    const signals = await gatherSignals(r);
    const byTitle = new Map(signals.map((s) => [s.summary, s.skill]));
    expect(byTitle.get("filed and refuted: stamped")).toBe("judge-geometry");
    expect(byTitle.get("filed and refuted: legacy")).toBe("judge-core");
  });

  test("a by-design of a VERIFIED finding is the refuter's lesson, an unverified one the owning panel's", async () => {
    const r = await projectWith([
      finding({ fingerprint: "fpv", status: "by-design", reason: "intended", verified: true }),
      finding({ fingerprint: "fpu", attribute: "y", status: "by-design", reason: "intended", verified: false }),
    ]);
    const signals = await gatherSignals(r);
    const bySrc = new Map(signals.map((s) => [s.source, s]));
    // The fixture's findings are contrast, which judge-visibility owns: the
    // unverified one is that panel's filing lesson, and the refuter's lesson
    // still licenses the panel whose claim it confirmed.
    expect(bySrc.get("fpv")?.skill).toBe("refute-finding");
    expect(bySrc.get("fpv")?.licenses).toEqual(["judge-visibility"]);
    expect(bySrc.get("fpu")?.skill).toBe("judge-visibility");
  });

  test("the standalone verify report feeds verify-acceptance signals", async () => {
    const r = await projectWith([]);
    mkdirSync(evidenceDir(r), { recursive: true });
    writeFileSync(
      join(evidenceDir(r), "verify-report.json"),
      JSON.stringify({
        criteriaSource: "ticket.md",
        criteria: [
          { id: 1, text: "loads fast", verdict: "not-verifiable", reasoning: "not visual" },
          { id: 2, text: "has a header", verdict: "pass", reasoning: "visible" },
        ],
      }),
    );
    const signals = await gatherSignals(r);
    const va = signals.filter((s) => s.skill === "verify-acceptance");
    expect(va).toHaveLength(1);
    expect(va[0]!.summary).toContain("loads fast");
  });
});

describe("the watermark", () => {
  test("consumed signals stop being new; unseen ones remain", async () => {
    const r = await projectWith([
      finding({ fingerprint: "fp1", status: "by-design", reason: "one", verified: false }),
    ]);
    const first = await gatherSignals(r);
    let mark = await loadWatermark(r);
    expect(newSignals(mark, first)).toHaveLength(1);

    await stampSeen(r, mark, first, "applied");
    mark = await loadWatermark(r);
    expect(newSignals(mark, first)).toHaveLength(0);
    expect(mark.lastAction).toBe("applied");

    // A new adjudication arrives: only it is new.
    const b = await import("../src/verbs/backlog.js");
    const backlog = await b.loadBacklog(r);
    backlog.findings["fp2"] = finding({
      fingerprint: "fp2", attribute: "z", status: "by-design", reason: "two", verified: false,
    });
    await saveBacklog(r, backlog);
    const second = await gatherSignals(r);
    expect(second).toHaveLength(2);
    expect(newSignals(mark, second).map((s) => s.source)).toEqual(["fp2"]);
  });

  test("stamping on a rollback still consumes: identical evidence never pays twice", async () => {
    const r = await projectWith([
      finding({ status: "by-design", reason: "intended", verified: false }),
    ]);
    const signals = await gatherSignals(r);
    const mark = await loadWatermark(r);
    await stampSeen(r, mark, signals, "rolled-back");
    const reloaded = await loadWatermark(r);
    expect(newSignals(reloaded, await gatherSignals(r))).toHaveLength(0);
    expect(reloaded.lastAction).toBe("rolled-back");
  });
});
