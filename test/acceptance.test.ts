// What would prove an issue fixed, and who is allowed to say it has been.
//
// Every issue carries criteria from the moment it is filed, so "is it fixed" is
// never answered from memory of what the defect looked like. Only lookout rules
// on them: these pin how they are written, how they survive a merge, and how
// each source is decided by the thing that can actually decide it.
import { describe, expect, test } from "bun:test";
import {
  acceptanceTally,
  blocksPass,
  composeAcceptance,
  criteriaFor,
  derivedCriterion,
  RECAPTURE_CRITERION,
  type AcceptanceCriterion,
} from "../src/issues/acceptance.js";
import {
  asCriteriaText,
  judgeableCriteria,
  matchJudged,
  ruleAcceptance,
} from "../src/issues/rule-acceptance.js";
import { reconcileIssues } from "../src/issues/registry.js";
import { checkBacklog, emptyBacklog, type Backlog, type BacklogFinding } from "../src/backlog/lib.js";

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  return {
    fingerprint: "app./dash.rest.desktop.dark.color-scheme.theme-not-switching",
    target: "app",
    route: "/dash",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "dark",
    category: "color-scheme",
    attribute: "theme-not-switching",
    severity: "high",
    status: "open",
    reason: null,
    title: "Light scheme renders the dark theme",
    problem: "The light capture shows the dark palette.",
    expected: "A light page background with dark text",
    observed: "Indistinguishable from the dark capture.",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [
      { shotId: "web/app/dash/rest/desktop/dark", path: "a.png", hash: "h", runId: "r1" },
    ],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

describe("where criteria come from", () => {
  test("a deterministic check states itself, passing, with no model involved", () => {
    const axe = finding({
      channel: "deterministic",
      category: "a11y",
      attribute: "axe-button-name",
    });
    expect(derivedCriterion(axe)).toBe(
      "No accessibility violation of rule `button-name` on /dash at desktop, dark scheme.",
    );
    const overflow = finding({
      channel: "deterministic",
      category: "layout-overflow",
      attribute: "horizontal-scroll",
      formFactor: "phone",
    });
    expect(derivedCriterion(overflow)).toBe("/dash does not scroll horizontally at phone.");
  });

  test("a judged finding uses the judge's own criteria", () => {
    const f = finding({ acceptance: ["The nav surface is darker than the page behind it."] });
    expect(criteriaFor(f).map((c) => c.text)).toEqual([
      "The nav surface is darker than the page behind it.",
    ]);
    expect(criteriaFor(f)[0]!.source).toBe("judge");
  });

  test("a finding filed before the judge wrote them falls back to its own expected prose", () => {
    // Not nothing: an issue with no criteria is an issue nobody can close.
    const criteria = criteriaFor(finding({ acceptance: [] }));
    expect(criteria).toHaveLength(1);
    expect(criteria[0]!.text).toContain("A light page background with dark text");
    expect(criteria[0]!.text).toContain("/dash at desktop, dark scheme");
  });

  test("every issue carries the guard that pixels must have moved", () => {
    const composed = composeAcceptance([finding()]);
    expect(composed.some((c) => c.text === RECAPTURE_CRITERION)).toBe(true);
    expect(composed.find((c) => c.text === RECAPTURE_CRITERION)!.source).toBe("universal");
  });
});

describe("composing an issue's list", () => {
  test("keeps what has already been ruled when a merge adds a finding", () => {
    const first = composeAcceptance([finding({ acceptance: ["A is true."] })]);
    const ruled = first.map((c) =>
      c.text === "A is true." ? { ...c, verdict: "met" as const, note: "seen" } : c,
    );
    const second = composeAcceptance(
      [finding({ acceptance: ["A is true."] }), finding({ fingerprint: "b", acceptance: ["B is true."] })],
      ruled,
    );
    expect(second.find((c) => c.text === "A is true.")!.verdict).toBe("met");
    expect(second.find((c) => c.text === "B is true.")!.verdict).toBe("pending");
  });

  test("drops a criterion whose finding is gone, and never duplicates one", () => {
    const both = composeAcceptance([
      finding({ acceptance: ["A is true."] }),
      finding({ fingerprint: "b", acceptance: ["A is true."] }),
    ]);
    // Same text from two findings is one criterion.
    expect(both.filter((c) => c.text === "A is true.")).toHaveLength(1);

    const fewer = composeAcceptance([finding({ fingerprint: "b", acceptance: ["B is true."] })], both);
    expect(fewer.some((c) => c.text === "A is true.")).toBe(false);
  });
});

describe("ruling them", () => {
  const base = {
    changedShots: 2,
    totalShots: 4,
    deterministic: { freshFingerprints: new Set<string>(), recapturedFingerprints: new Set(["fp"]) },
    judged: new Map(),
    ruledAt: "2026-01-01T00:00:00.000Z",
    runId: "verify-1",
  };
  const derived: AcceptanceCriterion = {
    id: "c1",
    text: "No accessibility violation of rule `button-name`.",
    source: "derived",
    from: "fp",
    verdict: "pending",
  };
  const universal: AcceptanceCriterion = {
    id: "c2",
    text: RECAPTURE_CRITERION,
    source: "universal",
    verdict: "pending",
  };

  test("the check that filed it rules it", () => {
    const met = ruleAcceptance({ ...base, criteria: [derived] })[0]!;
    expect(met.verdict).toBe("met");
    expect(met.runId).toBe("verify-1");

    const stillFiring = ruleAcceptance({
      ...base,
      criteria: [derived],
      deterministic: { ...base.deterministic, freshFingerprints: new Set(["fp"]) },
    })[0]!;
    expect(stillFiring.verdict).toBe("unmet");
  });

  test("a criterion whose screenshot was not re-captured is not verifiable, not failed", () => {
    const out = ruleAcceptance({
      ...base,
      criteria: [derived],
      deterministic: { freshFingerprints: new Set(), recapturedFingerprints: new Set() },
    })[0]!;
    expect(out.verdict).toBe("not-verifiable");
    expect(blocksPass([out])).toHaveLength(0);
  });

  test("the pixels-moved guard is ruled by the hashes", () => {
    expect(ruleAcceptance({ ...base, criteria: [universal] })[0]!.verdict).toBe("met");
    const nothingMoved = ruleAcceptance({ ...base, criteria: [universal], changedShots: 0 })[0]!;
    expect(nothingMoved.verdict).toBe("unmet");
    expect(nothingMoved.note).toContain("byte-identical");
  });

  test("a judge criterion the verifier never reached keeps its verdict and blocks nothing", () => {
    const judgeCriterion: AcceptanceCriterion = {
      id: "c3",
      text: "The nav surface is darker than the page.",
      source: "judge",
      verdict: "pending",
    };
    const out = ruleAcceptance({ ...base, criteria: [judgeCriterion] })[0]!;
    expect(out.verdict).toBe("pending");
    expect(out.ruledAt).toBeUndefined();
    expect(blocksPass([out])).toHaveLength(0);
  });

  test("only a failing criterion blocks a pass", () => {
    const criteria: AcceptanceCriterion[] = [
      { ...derived, verdict: "met" },
      { ...universal, verdict: "not-verifiable" },
      { ...derived, id: "c9", verdict: "unmet" },
    ];
    expect(blocksPass(criteria).map((c) => c.id)).toEqual(["c9"]);
    expect(acceptanceTally(criteria)).toEqual({
      met: 1,
      unmet: 1,
      notVerifiable: 1,
      pending: 0,
      total: 3,
    });
  });
});

describe("matching the verifier's answers back", () => {
  const criteria: AcceptanceCriterion[] = [
    { id: "a", text: "First thing is true.", source: "judge", verdict: "pending" },
    { id: "b", text: "Second thing is true.", source: "judge", verdict: "pending" },
  ];

  test("numbered text goes out and numbered verdicts come back", () => {
    expect(asCriteriaText(criteria)).toBe("1. First thing is true.\n2. Second thing is true.");
    const matched = matchJudged(criteria, [
      { id: 1, text: "First thing is true.", verdict: "pass", reasoning: "seen" },
      { id: 2, text: "Second thing is true.", verdict: "fail", reasoning: "not seen" },
    ]);
    expect(matched.get("a")!.verdict).toBe("pass");
    expect(matched.get("b")!.verdict).toBe("fail");
  });

  test("a verifier that renumbered is matched on the text instead", () => {
    const matched = matchJudged(criteria, [
      { id: 7, text: "second thing is true", verdict: "pass", reasoning: "seen" },
    ]);
    expect(matched.get("b")!.verdict).toBe("pass");
    expect(matched.has("a")).toBe(false);
  });

  test("only judge-authored criteria are sent to a model", () => {
    const mixed: AcceptanceCriterion[] = [
      ...criteria,
      { id: "u", text: RECAPTURE_CRITERION, source: "universal", verdict: "pending" },
      { id: "d", text: "No axe violation.", source: "derived", from: "fp", verdict: "pending" },
    ];
    expect(judgeableCriteria(mixed).map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("`backlog check` requires them", () => {
  test("an issue with no criteria is a problem", () => {
    const b: Backlog = emptyBacklog("app", "t");
    const f = finding();
    b.findings[f.fingerprint] = f;
    reconcileIssues(b, "t");
    expect(checkBacklog(b, { mdOnDisk: null, latestReport: null })).toHaveLength(0);

    const id = Object.keys(b.issues)[0]!;
    b.issues[id] = { ...b.issues[id]!, acceptance: [] };
    expect(
      checkBacklog(b, { mdOnDisk: null, latestReport: null }).map((p) => p.kind),
    ).toContain("acceptance-missing");
  });
});
