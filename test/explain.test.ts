// A deterministic finding's message is written to be precise, not to be read.
// These pin the prose that gets written alongside it: what a person would
// notice first, then the check's own measurement, and never the one string
// copied into both the title and the body, which is how an accessibility
// ticket came to print its own heading as the whole of what was wrong.
import { describe, expect, test } from "bun:test";
import { explainDeterministic } from "../src/backlog/explain.js";
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
