// What lookout keeps of a failing element's markup, and the finding an axe
// violation becomes. The markup is summarised at capture, never stored whole:
// it can carry a row of somebody's data, and the folder it ends up in is
// committed with the project.
import { describe, expect, test } from "bun:test";
import { axeFinding, newAxeFindings, rememberAxe, summariseHtml, type AxeViolation } from "../src/capture/axe.js";

describe("summarising an element's markup", () => {
  test("keeps the tag, a few naming attributes and the visible text, nothing else", () => {
    const s = summariseHtml(
      '<input id="email" class="field field--wide js-track extra" type="email" name="email" value="alice@example.com" data-user="42" style="color:red" onfocus="x()" placeholder="you@..." />',
    );
    expect(s).toEqual({ tag: "input", attrs: { id: "email", class: "field field--wide js-track", type: "email", name: "email" }, text: "" });
  });

  test("an href keeps its origin and path and loses its query and fragment", () => {
    expect(summariseHtml('<a href="https://app.example/settings?token=abc#top">Settings</a>').attrs.href).toBe("https://app.example/settings");
    expect(summariseHtml('<a href="/dash?u=1">Dash</a>').attrs.href).toBe("/dash");
  });

  test("the visible text is the element's words with the markup stripped, at most 80 characters", () => {
    const s = summariseHtml(`<h5 class="t"><span>Recent</span>   activity <img alt="x"/> ${"and more ".repeat(20)}</h5>`);
    expect(s.tag).toBe("h5");
    expect(s.text.startsWith("Recent activity and more")).toBe(true);
    expect(s.text.length).toBe(80);
  });

  test("markup that is not an element still yields something", () => {
    expect(summariseHtml("just text")).toEqual({ tag: "element", attrs: {}, text: "just text" });
  });
});

describe("a violation as a finding", () => {
  const violation = (nodes: number): AxeViolation => ({
    id: "heading-order",
    impact: "moderate",
    help: "Heading levels should only increase by one",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/heading-order",
    description: "Ensures the order of headings is semantically correct",
    tags: ["cat.semantics", "best-practice", "wcag2a", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8"],
    nodes: Array.from({ length: nodes }, (_, i) => ({
      target: ["main", `h5:nth-of-type(${i + 1})`],
      html: `<h5 class="title">Section ${i + 1}</h5>`,
      impact: "moderate",
      failureSummary: "Fix any of the following:\n  Heading order invalid",
      any: [{ message: "Heading order invalid" }, { message: "Heading order invalid" }],
      all: [{ message: "Second check" }, { message: "Third" }, { message: "Fourth" }, { message: "Fifth" }],
      none: [],
    })),
  });

  test("keeps the record the prose is written from, bounded", () => {
    const f = axeFinding(violation(25));
    expect(f.type).toBe("axe-violation");
    expect(f.severity).toBe("warning");
    expect(f.message).toBe("heading-order: Heading levels should only increase by one");
    const m = f.meta!;
    expect(m.nodeCount).toBe(25);
    expect(m.targets).toEqual(["main h5:nth-of-type(1)", "main h5:nth-of-type(2)", "main h5:nth-of-type(3)"]);
    expect((m.failureSummary as string[]).length).toBe(3);
    expect((m.tags as string[]).length).toBe(10);
    const nodes = m.nodes as { target: string; impact: string; element: { tag: string; attrs: Record<string, string>; text: string }; checks: string[] }[];
    expect(nodes).toHaveLength(20);
    expect(nodes[0]).toEqual({
      target: "main h5:nth-of-type(1)",
      impact: "moderate",
      element: { tag: "h5", attrs: { class: "title" }, text: "Section 1" },
      checks: ["Heading order invalid", "Second check", "Third", "Fourth"],
    });
  });

  test("a serious or critical impact is an error; anything else a warning", () => {
    expect(axeFinding({ ...violation(1), impact: "critical" }).severity).toBe("error");
    expect(axeFinding({ ...violation(1), impact: "minor" }).severity).toBe("warning");
  });
});

describe("the same violation at a narrower form factor", () => {
  const finding = (rule: string, targets: string[]) => ({
    type: "axe-violation" as const,
    severity: "error" as const,
    message: `${rule}: help`,
    meta: {
      ruleId: rule,
      nodeCount: targets.length,
      targets: targets.slice(0, 3),
      nodes: targets.map((target) => ({ target, element: { tag: "img", attrs: {}, text: "" } })),
    },
  });

  test("a violation every node of which the wider layout already showed is not filed again", () => {
    const seen = new Map<string, Set<string>>();
    rememberAxe([finding("image-alt", ["img.logo"])], seen);
    expect(newAxeFindings([finding("image-alt", ["img.logo"])], seen)).toEqual([]);
  });

  test("a node only the narrower layout shows is filed, and the finding names only that node", () => {
    const seen = new Map<string, Set<string>>();
    rememberAxe([finding("button-name", ["button.share"])], seen);
    const out = newAxeFindings([finding("button-name", ["button.share", "button.menu"])], seen);
    expect(out).toHaveLength(1);
    expect(out[0]!.meta).toMatchObject({ ruleId: "button-name", nodeCount: 1, targets: ["button.menu"] });
    expect((out[0]!.meta!.nodes as { target: string }[]).map((n) => n.target)).toEqual(["button.menu"]);
    expect(out[0]!.message).toBe("button-name: help");
  });

  test("a different rule on a node already seen for another rule is still news", () => {
    const seen = new Map<string, Set<string>>();
    rememberAxe([finding("image-alt", ["img.logo"])], seen);
    expect(newAxeFindings([finding("link-name", ["img.logo"])], seen)).toHaveLength(1);
  });

  test("remembering then asking again is empty: the memory is idempotent", () => {
    const seen = new Map<string, Set<string>>();
    const twice = [finding("image-alt", ["img.a", "img.b"])];
    expect(newAxeFindings(twice, seen)).toHaveLength(1);
    rememberAxe(twice, seen);
    expect(newAxeFindings(twice, seen)).toEqual([]);
    rememberAxe(twice, seen);
    expect(newAxeFindings(twice, seen)).toEqual([]);
  });

  test("findings that are not axe's pass through untouched", () => {
    const seen = new Map<string, Set<string>>();
    const other = { type: "console-error" as const, severity: "error" as const, message: "boom" };
    expect(newAxeFindings([other], seen)).toEqual([other]);
  });
});
