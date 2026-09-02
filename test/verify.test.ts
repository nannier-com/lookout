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
import { incidentsPath } from "../src/skills/incidents.js";
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
  delete process.env.MOCK_VERIFY_CRITERIA;
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

  test("the refuter is told what scrolls, so it cannot call reachable content lost", () => {
    // The one refutation this check exists to prevent: a control past the edge
    // of a frame is either a defect or a scroll away, and the refuter, told to
    // lean refuted when uncertain, will guess the second every time.
    const s = shot("web/app/x/rest/phone/dark", {
      scrollers: [{ path: "div.scroller", tag: "div", width: 390, hiddenWidth: 1036 }],
    });
    const prompt = buildRefutePrompt(
      refute.text,
      [finding({ shotId: s.id })],
      new Map([[s.id, s]]),
      "/ev",
    );
    expect(prompt).toContain("measured: something in this view scrolls sideways");
    expect(prompt).toContain("1036px");
  });

  test("a view with nothing to scroll is told nothing about scrolling", () => {
    const s = shot("web/app/x/rest/desktop/dark");
    const prompt = buildRefutePrompt(refute.text, [finding()], new Map([[s.id, s]]), "/ev");
    expect(prompt).not.toContain("measured:");
  });

  test("a view with one shot is not given a pointless list of itself", () => {
    const s = shot("web/app/x/rest/desktop/dark");
    const prompt = buildRefutePrompt(refute.text, [finding()], new Map([[s.id, s]]), "/ev");
    expect(prompt).not.toContain("every shot of this view");
  });

  test("a sibling is put in front of the refuter as its own shot to rule on", () => {
    // The judge filed once and named the other shots; ingestion made each one a
    // finding. The refuter must be able to kill an over-listed sibling without
    // touching the primary, so a sibling arrives with its own file, its own
    // index, and an instruction saying so.
    const dark = shot("web/app/x/rest/desktop/dark");
    const light = shot("web/app/x/rest/desktop/light");
    const shotsById = new Map([
      [dark.id, dark],
      [light.id, light],
    ]);
    const prompt = buildRefutePrompt(
      refute.text,
      [finding(), finding({ shotId: light.id, siblingOf: dark.id })],
      shotsById,
      "/ev",
    );
    expect(prompt).toContain("#1 shotId: web/app/x/rest/desktop/light");
    expect(prompt).toContain("/ev/web/app/x/rest/desktop/light.png");
    expect(prompt).toContain("says THIS shot shows the same defect");
    expect(prompt).toContain("(#0)");
    // The claim travels; the paragraph does not, once per shot.
    expect(prompt.match(/problem: p/g)?.length).toBe(1);
    expect(prompt.match(/every shot of this view/g)?.length).toBe(1);
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

  test("what lookout measured is put in front of the refuter", async () => {
    // The refutation this exists to prevent: told to lean refuted when
    // uncertain, the verifier dismissed a control whose box lookout had
    // measured outside the page as a deliberate mobile simplification.
    const s = shot("web/app/x/rest/phone/dark", {
      deterministicFindings: [
        { type: "edge-clipped", severity: "error", message: '"Account" is cut off at the edge of the screen' },
      ],
    });
    const prompt = buildRefutePrompt(refute.text, [finding({ shotId: s.id })], new Map([[s.id, s]]), "/ev");
    expect(prompt).toContain("measured on this shot: edge-clipped:");
    expect(prompt).toContain('"Account" is cut off');
    // And the skill says what that line is worth.
    expect(prompt).toContain("Those are lookout's own");
  });

  test("acceptance criteria are numbered so a verdict can point at one", () => {
    const s = shot("web/app/x/rest/desktop/dark");
    const prompt = buildRefutePrompt(
      refute.text,
      [finding({ acceptance: ["The heading is larger than the rows.", "The card background is opaque."] })],
      new Map([[s.id, s]]),
      "/ev",
    );
    expect(prompt).toContain("acceptance criteria:");
    expect(prompt).toContain("1. The heading is larger than the rows.");
    expect(prompt).toContain("2. The card background is opaque.");
  });

  test("a criterion no screenshot could settle is replaced or dropped at filing time", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_VERIFY_CRITERIA = "1";
    const s = shot("web/app/x/rest/desktop/dark");
    const r = await verifyFindings(
      refute.text,
      [finding({ acceptance: ["The theme provider is configured.", "The page has a heading."] })],
      new Map([[s.id, s]]),
      mkdtempSync(join(tmpdir(), "lookout-verify-ev-")),
      "sonnet",
    );
    // The first had an observable replacement and takes it; the second was
    // already true on the defective shot and proves nothing, so it goes.
    expect(r.confirmed[0]!.acceptance).toEqual([
      "Body text is legible against the card at desktop width.",
    ]);
    expect(r.droppedCriteria.map((c) => c.reason)).toEqual([
      "undecidable-from-pixels",
      "passes-on-the-defective-shot",
    ]);
    expect(r.droppedCriteria[0]!.rewrite).toContain("legible");
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
    const r = tmpProject("lookout-refuter-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "ask";
    try {
      const f = finding({ severity: "critical" });
      const shots = new Map([[f.shotId, shot(f.shotId)]]);
      const res = await verifyFindings(refute.text, [f], shots, "/tmp", "sonnet", r.projectDir);
      expect(res.confirmed).toHaveLength(1);
      expect(res.confirmed[0]?.verified).toBe(false);
      expect(res.refuted).toHaveLength(0);
      const log = readFileSync(incidentsPath(r.projectDir), "utf8");
      expect(log).toContain("refuter: reply was not parseable JSON after a retry");
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });
});

describe("the refuter's plain half", () => {
  const detail = "The h5 and the body text sit at the same step of the type ramp with no weight difference between them.";
  const plain = "Nothing on this screen reads as its title: the heading above the table is no bigger than the rows under it.";
  const shots = new Map([["web/app/x/rest/desktop/dark", shot("web/app/x/rest/desktop/dark")]]);
  const arm = (value?: string) => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    if (value === undefined) delete process.env.MOCK_VERIFY_PLAIN;
    else process.env.MOCK_VERIFY_PLAIN = value;
  };
  afterEach(() => {
    delete process.env.MOCK_VERIFY_PLAIN;
  });

  test("is put above a one-part problem, and the repair names the panel", async () => {
    arm(plain);
    const dir = mkdtempSync(join(tmpdir(), "lookout-plain-"));
    const r = await verifyFindings(refute.text, [finding({ problem: detail, judge: "judge-text" } as Partial<AiFinding>)], shots, dir, "m");
    expect(r.confirmed[0]!.problem).toBe(`${plain}\n\n${detail}`);
    expect(r.repaired).toEqual([{ shotId: "web/app/x/rest/desktop/dark", category: "color-scheme", attribute: "dark-surface", title: "t", judge: "judge-text", plain }]);
  });

  test("is not adopted when the judge's text already opens with one", async () => {
    arm("Another sentence a person could follow about the same screen and the same heading.");
    const dir = mkdtempSync(join(tmpdir(), "lookout-plain-"));
    const twoPart = `${plain}\n\n${detail}`;
    const r = await verifyFindings(refute.text, [finding({ problem: twoPart })], shots, dir, "m");
    expect(r.confirmed[0]!.problem).toBe(twoPart);
    expect(r.repaired).toEqual([]);
  });

  test("is dropped when it fails the bar, and the finding stands as written", async () => {
    arm("The `h5` is wrong.");
    const dir = mkdtempSync(join(tmpdir(), "lookout-plain-"));
    const r = await verifyFindings(refute.text, [finding({ problem: detail })], shots, dir, "m");
    expect(r.confirmed[0]!.problem).toBe(detail);
    expect(r.confirmed[0]!.verified).toBe(true);
    expect(r.repaired).toEqual([]);
  });

  test("a refuted finding never takes one", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    process.env.MOCK_VERIFY = JSON.stringify({ verdicts: [{ index: 0, verdict: "refuted", note: "not there", plain }] });
    const dir = mkdtempSync(join(tmpdir(), "lookout-plain-"));
    const r = await verifyFindings(refute.text, [finding({ problem: detail })], shots, dir, "m");
    delete process.env.MOCK_VERIFY;
    expect(r.confirmed).toEqual([]);
    expect(r.refuted[0]!.problem).toBe(detail);
    expect(r.repaired).toEqual([]);
  });
});
