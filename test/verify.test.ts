// The adversarial pass: what gets a second opinion, and what it is shown.
//
// Severity says how much a defect costs if it is real. It says nothing about
// how likely the judge was to be wrong, and those are different questions. A
// claim resting on a named principle is the judge's most valuable output and its
// most refutable, at any severity.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRefutePrompt, needsRefuting, verifyFindings } from "../src/judge/verify.js";
import { loadSkill } from "../src/skills/load.js";
import { tmpProject } from "./tmp-project.js";
import type { AiFinding } from "../src/judge/engine.js";
import type { ShotRecord } from "../src/types.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");
const refute = await loadSkill(tmpProject("lookout-verify-"), "refute-finding");

function shot(id: string, over: Partial<ShotRecord> = {}): ShotRecord {
  const [platform, target, routeSlug, state, formFactor, scheme] = id.split("/");
  return {
    id,
    target: target!,
    route: `/${routeSlug}`,
    routeName: routeSlug!,
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
    capturedAt: "2026-08-25T00:00:00Z",
    runId: "test",
    deterministicFindings: [],
    ...over,
  };
}

function finding(over: Partial<AiFinding> = {}): AiFinding {
  return {
    shotId: "web/app/x/rest/desktop/dark",
    category: "color-scheme",
    attribute: "dark-surface",
    severity: "high",
    title: "t",
    problem: "p",
    expected: "e",
    observed: "o",
    confidence: "high",
    acceptance: [],
    ...over,
  } as AiFinding;
}

// The mock reads MOCK_MODE, and self-heal's own tests rely on it being unset so
// the mock can pick its mode from the prompt. Leaving it behind made those fail
// from here.
afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_MODE;
});

describe("what earns a second opinion", () => {
  // Every AI finding, deliberately. The old boundary (critical/high, plus six
  // "quality band" categories at any severity) contradicted the rubric's own
  // ladder: it defines low as "a named principle broken", which makes every
  // low finding a principle claim, and it left design-parity, color-scheme
  // and responsive, the comparative categories the refuter was re-plumbed
  // for, unrefuted at medium and low. The marginal cost is zero extra calls:
  // the refuter already runs once per judged batch, and the boundary only
  // decided which findings rode along.
  test("every severity, every category", () => {
    for (const severity of ["critical", "high", "medium", "low"] as const) {
      expect(needsRefuting(finding({ severity }))).toBe(true);
    }
    for (const category of [
      "hierarchy",
      "composition",
      "spacing",
      "typography",
      "alignment",
      "consistency",
      "design-parity",
      "color-scheme",
      "responsive",
      "content",
      "render-failure",
      "a11y",
    ]) {
      expect(needsRefuting(finding({ category, severity: "low" } as Partial<AiFinding>))).toBe(true);
    }
  });
});

describe("what the refuter is shown", () => {
  test("a comparative finding is given every shot of its view", () => {
    // The rubric has the judge compare dark against light and one form factor
    // against another, so those findings are claims about a comparison. Handing
    // the refuter one image and telling it to lean refuted when uncertain meant
    // the findings needing the most evidence were given the least.
    const shotsById = new Map(
      ["dark", "light"].map((sc) => {
        const s = shot(`web/app/x/rest/desktop/${sc}`);
        return [s.id, s] as const;
      }),
    );
    const prompt = buildRefutePrompt(refute.text, [finding()], shotsById, "/ev");
    expect(prompt).toContain("every shot of this view");
    expect(prompt).toContain("/ev/web/app/x/rest/desktop/light.png");
    expect(prompt).toContain("the shot this was filed on");
  });

  test("a view with one shot is not given a pointless list of itself", () => {
    const s = shot("web/app/x/rest/desktop/dark");
    const prompt = buildRefutePrompt(refute.text, [finding()], new Map([[s.id, s]]), "/ev");
    expect(prompt).not.toContain("every shot of this view");
  });

  test("shots of other views are not offered as evidence for this one", () => {
    const own = shot("web/app/x/rest/desktop/dark");
    const other = shot("web/app/elsewhere/rest/desktop/dark");
    const prompt = buildRefutePrompt(
      refute.text,
      [finding()],
      new Map([
        [own.id, own],
        [other.id, other],
      ]),
      "/ev",
    );
    expect(prompt).not.toContain("elsewhere");
  });

  test("a confirmed finding comes back flagged", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    const f = finding();
    const shotsById = new Map([[f.shotId, shot(f.shotId)]]);
    const res = await verifyFindings(refute.text, [f], shotsById, "/tmp", "sonnet");
    expect(res.confirmed).toHaveLength(1);
    expect(res.confirmed[0]!.verified).toBe(true);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("a refuted finding is dropped from the results and kept for the report", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    const a = finding({ attribute: "one" });
    const b = finding({ attribute: "two" });
    const shotsById = new Map([[a.shotId, shot(a.shotId)]]);
    const res = await verifyFindings(refute.text, [a, b], shotsById, "/tmp", "sonnet");
    // The mock confirms index 0 and refutes everything after it.
    expect(res.confirmed.map((f) => f.attribute)).toEqual(["one"]);
    expect(res.refuted.map((f) => f.attribute)).toEqual(["two"]);
  });

  test("an unparseable verdict keeps every finding rather than dropping defects", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "ask"; // plain prose, no json
    const f = finding();
    const shotsById = new Map([[f.shotId, shot(f.shotId)]]);
    const res = await verifyFindings(refute.text, [f], shotsById, "/tmp", "sonnet");
    expect(res.confirmed).toHaveLength(1);
    // Kept, but honestly: nothing checked it.
    expect(res.confirmed[0]!.verified).toBe(false);
    expect(res.refuted).toHaveLength(0);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });
});

describe("the refuter's retry", () => {
  test("one garbage reply is retried, and the second answer stands", async () => {
    const flaky = join(mkdtempSync(join(tmpdir(), "flaky-")), "state");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    process.env.MOCK_FLAKY_FILE = flaky;
    try {
      const f = finding({ severity: "critical" });
      const shots = new Map([[f.shotId, shot(f.shotId)]]);
      const res = await verifyFindings(refute.text, [f], shots, "/tmp", "sonnet");
      // verify mode confirms index 0, so the retried call lands a verdict.
      expect(res.confirmed[0]?.verified).toBe(true);
    } finally {
      delete process.env.MOCK_FLAKY_FILE;
    }
  });

  test("two garbage replies record an incident and keep every finding unverified", async () => {
    const home = mkdtempSync(join(tmpdir(), "lookout-home-"));
    process.env.LOOKOUT_HOME = home;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "ask";
    try {
      const f = finding({ severity: "critical" });
      const shots = new Map([[f.shotId, shot(f.shotId)]]);
      const res = await verifyFindings(refute.text, [f], shots, "/tmp", "sonnet");
      expect(res.confirmed).toHaveLength(1);
      expect(res.confirmed[0]?.verified).toBe(false);
      expect(res.refuted).toHaveLength(0);
      const log = readFileSync(join(home, "incidents.jsonl"), "utf8");
      expect(log).toContain("refuter: reply was not parseable JSON after a retry");
    } finally {
      delete process.env.LOOKOUT_HOME;
    }
  });
});
