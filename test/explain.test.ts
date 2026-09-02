// A deterministic finding's message is written to be precise, not to be read.
// These pin the prose that gets written alongside it: what a person would
// notice first, then the check's own measurement, and never the one string
// copied into both the title and the body, which is how an accessibility
// ticket came to print its own heading as the whole of what was wrong.
import { describe, expect, test } from "bun:test";
import { explainDeterministic } from "../src/backlog/explain.js";
import { DETERMINISTIC_TYPES } from "../src/backlog/ingest.js";
import type { DeterministicFinding } from "../src/types.js";

const axe = (meta: Record<string, unknown>): DeterministicFinding => ({
  type: "axe-violation",
  severity: "warning",
  message: "heading-order: Heading levels should only increase by one",
  meta: {
    ruleId: "heading-order",
    impact: "moderate",
    nodeCount: 2,
    targets: ["#root > div > h4", "main h5"],
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/heading-order",
    description: "Ensures the order of headings is semantically correct",
    failureSummary: ["Fix any of the following: Heading order invalid"],
    ...meta,
  },
});

describe("an accessibility violation explains itself", () => {
  test("the problem is never just the message again", () => {
    const p = explainDeterministic(axe({}));
    expect(p.problem).not.toBe("heading-order: Heading levels should only increase by one");
    expect(p.problem.length).toBeGreaterThan(200);
  });

  test("it leads with what a person would notice, then the detail", () => {
    const { problem } = explainDeterministic(axe({}));
    const [plain, detail] = problem.split("\n\n");
    // The plain half is prose: axe's own description, and the warning that the
    // screenshot looking fine is not evidence against the finding.
    expect(plain).toContain("Ensures the order of headings is semantically correct");
    expect(plain).toContain("screen reader");
    expect(plain).toContain("moderate");
    // The rule id belongs in the half an agent acts on, not in the plain one.
    expect(plain).not.toContain("`heading-order`");
    expect(detail).toContain("`heading-order`");
  });

  test("it says which elements and where to read more", () => {
    const { problem } = explainDeterministic(axe({}));
    expect(problem).toContain("2 elements");
    expect(problem).toContain("#root > div > h4");
    expect(problem).toContain("main h5");
    expect(problem).toContain("Fix any of the following: Heading order invalid");
    expect(problem).toContain("https://dequeuniversity.com/rules/axe/4.10/heading-order");
  });

  test("expected and observed are filled, where they used to be empty", () => {
    const p = explainDeterministic(axe({}));
    expect(p.expected).toContain("heading-order");
    expect(p.observed).toContain("2 elements");
  });

  test("one element is said in the singular", () => {
    const p = explainDeterministic(axe({ nodeCount: 1, targets: ["main h5"] }));
    expect(p.problem).toContain("1 element on this screen");
    expect(p.observed).toContain("1 element on this screen fails it");
  });

  test("a violation axe told us nothing extra about still reads as prose", () => {
    const bare: DeterministicFinding = {
      type: "axe-violation",
      severity: "error",
      message: "region: All page content should be contained by landmarks",
      meta: { ruleId: "region" },
    };
    const p = explainDeterministic(bare);
    expect(p.problem).toContain("All page content should be contained by landmarks.");
    expect(p.problem).toContain("screen reader");
    // Nothing invented: no element count, no link, no impact sentence.
    expect(p.problem).not.toContain("It fired on");
    expect(p.problem).not.toContain("Reference:");
    expect(p.observed).toBe("");
  });
});

describe("the other checks say why their measurement matters", () => {
  test("a console error is explained as a defect that has not surfaced yet", () => {
    const p = explainDeterministic({
      type: "console-error",
      severity: "error",
      message: "TypeError: Cannot read properties of undefined (reading 'id')",
    });
    expect(p.problem).toContain("may look finished");
    expect(p.problem).toContain("What the check measured: TypeError: Cannot read properties");
  });

  test("horizontal overflow is explained at human scale", () => {
    const p = explainDeterministic({
      type: "horizontal-overflow",
      severity: "warning",
      message: "content protrudes 42px horizontally (.card__title)",
    });
    expect(p.problem).toContain("scroll");
    expect(p.problem).toContain("(.card__title)");
  });

  test("the check's own message is always kept intact", () => {
    const types = [
      "console-error", "page-error", "request-failed", "horizontal-overflow",
      "blank-shot", "capture-error", "scheme-mismatch", "stale-frame",
      "off-origin", "dead-interaction",
    ] as const;
    for (const type of types) {
      const p = explainDeterministic({ type, severity: "error", message: "the measurement" });
      expect({ type, kept: p.problem.includes("the measurement") }).toEqual({ type, kept: true });
      expect({ type, same: p.problem === "the measurement" }).toEqual({ type, same: false });
    }
  });
});

describe("an accessibility violation whose capture kept the elements", () => {
  const rich = () =>
    axe({
      tags: ["cat.semantics", "wcag2a", "wcag21aa", "best-practice"],
      nodes: [
        { target: "#root > div > h4", element: { tag: "h4", attrs: {}, text: "Overview" }, checks: ["Heading order invalid"] },
        { target: "main h5", element: { tag: "h5", attrs: { id: "recent" }, text: "Recent activity" }, checks: ["Heading order invalid", "Level skipped"] },
      ],
    });

  test("names the elements as a person would point at them, not their selectors", () => {
    const { problem, observed } = explainDeterministic(rich());
    expect(problem).toContain('It fired on 2 elements on this screen: the `<h4>` reading "Overview", the `<h5 id="recent">` reading "Recent activity".');
    expect(problem).not.toContain("`#root > div > h4`");
    // The selectors are still the record's, for the agent that resolves them.
    expect(observed).toContain("`#root > div > h4`");
  });

  test("says which standard the rule belongs to, from axe's own tags", () => {
    const { problem } = explainDeterministic(rich());
    const [plain] = problem.split("\n\n");
    expect(plain).toContain("It is a WCAG 2.0 level A requirement.");
    const advice = explainDeterministic(axe({ tags: ["best-practice", "cat.semantics"], nodes: [] }));
    expect(advice.problem).toContain("It is an axe best-practice rule rather than a WCAG requirement.");
    expect(explainDeterministic(axe({ tags: [], nodes: [] })).problem).not.toContain("requirement");
  });

  test("writes one sentence per check, per element, in place of the flattened summary", () => {
    const { problem } = explainDeterministic(rich());
    expect(problem).toContain('What axe checked on the `<h4>` reading "Overview": Heading order invalid.');
    expect(problem).toContain('What axe checked on the `<h5 id="recent">` reading "Recent activity": Heading order invalid. Level skipped.');
    expect(problem).not.toContain("axe's own account of what to change");
  });

  test("a capture that kept no elements reads as before", () => {
    const { problem } = explainDeterministic(axe({}));
    expect(problem).toContain("It fired on 2 elements on this screen: `#root > div > h4`, `main h5`.");
    expect(problem).toContain("axe's own account of what to change: Fix any of the following: Heading order invalid.");
  });
});

describe("every check has a title that is not its message", () => {
  const every: DeterministicFinding[] = [
    { type: "console-error", severity: "error", message: "TypeError: x is undefined", meta: { url: "http://a/main.js", line: 12, repeats: 3 } },
    { type: "page-error", severity: "error", message: "ReferenceError: y", meta: { stack: "ReferenceError: y\n    at boot (http://a/main.js:3:1)" } },
    { type: "request-failed", severity: "warning", message: "net::ERR_FAILED: http://a/api/items", meta: { url: "http://a/api/items", method: "POST", resourceType: "fetch" } },
    { type: "horizontal-overflow", severity: "error", message: "content protrudes 42px horizontally (.card__title)", meta: { worst: 42, offender: ".card__title", offenderPath: "main > div" } },
    { type: "horizontal-overflow", severity: "error", message: "page scrolls 220px sideways at 390px viewport", meta: { delta: 220, viewport: 390, offenderPath: "table" } },
    { type: "blank-shot", severity: "error", message: "image is near-uniform" },
    { type: "capture-error", severity: "warning", message: 'interaction state "menu-open" failed: timeout', meta: { state: "menu-open" } },
    { type: "scheme-mismatch", severity: "warning", message: "dark and light captures are byte-identical" },
    { type: "stale-frame", severity: "warning", message: "two samples differed" },
    { type: "off-origin", severity: "error", message: "capture landed on http://accounts.example", meta: { landed: "http://accounts.example", expected: "http://127.0.0.1:5999" } },
    { type: "dead-interaction", severity: "warning", message: '"Menu" (header button) did nothing when clicked', meta: { name: "Menu", href: null } },
    { type: "edge-clipped", severity: "error", message: '"Account" extends 43px past the right edge of the viewport and the page does not scroll to reach it', meta: { clipper: "viewport", offenderPath: "header > button:nth-of-type(2)", clipped: 2, offenders: [{ path: "header > button:nth-of-type(2)", tag: "button", text: "Account", overRight: 43, overBottom: 0 }] } },
    { type: "edge-clipped", severity: "error", message: '"Last seen" extends 88px past the right edge of an ancestor that hides its overflow', meta: { clipper: "ancestor", offenderPath: "table > thead > tr > th:nth-of-type(5)", clipped: 1, offenders: [{ path: "table > thead > tr > th:nth-of-type(5)", tag: "th", text: "Last seen", overRight: 88, overBottom: 0 }] } },
    { type: "box-collision", severity: "warning", message: '"Person" is drawn over "Bobby Nannier", covering 34% of it', meta: { offenderPath: "span.chip", collisions: 8, pairs: [{ topPath: "span.chip", topText: "Person", underPath: "td > a", underText: "Bobby Nannier", share: 0.34 }] } },
    axe({}),
  ];

  // The list above is hand-written, so a check type added later would get no
  // prose and nothing would say so: every assertion here would keep passing
  // over a type it never saw. This is the assertion that fails instead.
  test("the list covers every check lookout can file", () => {
    expect([...new Set(every.map((df) => df.type))].sort()).toEqual([...DETERMINISTIC_TYPES].sort());
  });

  test("no title leads with a rule id, and none is the raw message", () => {
    for (const df of every) {
      const p = explainDeterministic(df);
      expect({ type: df.type, prefixed: /^[a-z0-9-]+: /.test(p.title) }).toEqual({ type: df.type, prefixed: false });
      expect({ type: df.type, raw: p.title === df.message }).toEqual({ type: df.type, raw: false });
      expect({ type: df.type, expected: p.expected.length > 0, observed: p.observed.length > 0 }).toEqual({ type: df.type, expected: true, observed: true });
    }
  });

  test("the titles say what a person would recognise", () => {
    const t = (i: number) => explainDeterministic(every[i]!).title;
    expect(t(0)).toBe("The page logged an error: TypeError: x is undefined");
    expect(t(3)).toBe("Content runs 42px off the side of the screen (.card__title)");
    expect(t(4)).toBe("The page scrolls 220px sideways at 390px wide");
    expect(t(6)).toBe('lookout could not open the "menu-open" state to photograph it');
    expect(t(9)).toBe("The capture landed on http://accounts.example instead of the application");
    expect(t(10)).toBe('"Menu" did nothing when clicked');
    // Named by the words on screen, not by the selector: the point of the clip
    // check is that a person can go and look at the thing it names.
    expect(t(11)).toBe('"Account" is cut off at the edge of the screen with no way to scroll to it (and 1 more)');
    expect(t(12)).toBe('"Last seen" is cut off by the area that holds it');
    expect(t(13)).toBe('"Person" is drawn on top of "Bobby Nannier" (and 7 more)');
    expect(t(14)).toBe("Heading levels should only increase by one");
  });

  test("observed carries the record's detail; expected is the fixed state", () => {
    expect(explainDeterministic(every[0]!).observed).toBe("TypeError: x is undefined (http://a/main.js line 12), 3 times");
    expect(explainDeterministic(every[1]!).observed).toBe("ReferenceError: y (at boot (http://a/main.js:3:1))");
    expect(explainDeterministic(every[2]!).observed).toBe("net::ERR_FAILED: http://a/api/items (POST fetch)");
    expect(explainDeterministic(every[3]!).expected).toBe("Nothing on the page extends past the viewport's edge, and the page does not scroll sideways.");
    expect(explainDeterministic(every[10]!).expected).toBe('Clicking "Menu" changes the page.');
    expect(explainDeterministic(every[9]!).expected).toBe("The capture stays on http://127.0.0.1:5999.");
  });

  test("the five capture-side types say so first and record rather than measure", () => {
    for (const i of [5, 6, 7, 8, 9]) {
      const p = explainDeterministic(every[i]!);
      expect({ type: every[i]!.type, first: /^(This is a problem with (lookout's )?(the )?capture|Either the application ignores)/.test(p.problem) }).toEqual({ type: every[i]!.type, first: true });
      expect(p.problem).toContain("What lookout recorded: ");
      expect(p.problem).not.toContain("What the check measured");
    }
    expect(explainDeterministic(every[0]!).problem).toContain("What the check measured: ");
  });

  test("axe's impact sentence names the severity lookout files it under", () => {
    expect(explainDeterministic(axe({ impact: "moderate" })).problem).toContain("axe rates this moderate, which lookout files as medium");
    expect(explainDeterministic(axe({ impact: "critical" })).problem).toContain("axe rates this critical, which lookout files as high");
  });
});
