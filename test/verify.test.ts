// The adversarial pass: what gets a second opinion, and what it is shown.
//
// Severity says how much a defect costs if it is real. It says nothing about
// how likely the judge was to be wrong, and those are different questions. A
// claim resting on a named principle is the judge's most valuable output and its
// most refutable, at any severity.
import { afterEach, describe, expect, test } from "bun:test";
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
  test("serious findings, as before", () => {
    expect(needsRefuting(finding({ severity: "critical" }))).toBe(true);
    expect(needsRefuting(finding({ severity: "high" }))).toBe(true);
  });

  test("design-quality findings at any severity, because they are the arguable ones", () => {
    for (const category of [
      "hierarchy",
      "composition",
      "spacing",
      "typography",
      "alignment",
      "consistency",
    ]) {
      expect(needsRefuting(finding({ category, severity: "low" } as Partial<AiFinding>))).toBe(true);
    }
  });

  test("a minor claim about something plainly broken still does not need one", () => {
    // It is either in the image or it is not, and a cheap pass adds nothing.
    expect(needsRefuting(finding({ category: "content", severity: "low" }))).toBe(false);
    expect(needsRefuting(finding({ category: "render-failure", severity: "medium" }))).toBe(false);
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
