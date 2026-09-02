// Whether a problem text is written for both of its readers: the one bar
// ingest counts against, the refuter fills in for, backlog check flags, and
// the renderers drop the degenerate case by.
import { describe, expect, test } from "bun:test";
import { isExplained, isTitleAgain, problemLapses, splitProblem, withPlainHalf } from "../src/backlog/prose.js";

const plain = "The heading above the table is no bigger than the rows under it, so nothing on the screen reads as its title.";
const detail = "The h5 and the body text sit at the same step of the type ramp with no weight difference: hierarchy, typography.";

describe("the split", () => {
  test("the first blank line divides the plain half from the precise one", () => {
    expect(splitProblem(`${plain}\n\n${detail}`)).toEqual({ plain, detail });
    expect(splitProblem(`${plain}\n  \n${detail}`)).toEqual({ plain, detail });
    expect(splitProblem(plain)).toEqual({ plain, detail: null });
  });
});

describe("the lapses", () => {
  test("a problem that is its title again, in any case or punctuation, is unexplained", () => {
    expect(problemLapses({ title: "Heading order: levels skip.", problem: "heading order: levels skip" })).toEqual(["title-again"]);
    expect(isTitleAgain("  ", "x")).toBe(true);
    expect(problemLapses({ title: "t", problem: " " })).toEqual(["empty"]);
  });

  test("one paragraph is one part whatever it says", () => {
    expect(problemLapses({ title: "t", problem: plain })).toEqual(["one-part"]);
    expect(isExplained(plain, "t")).toBe(false);
  });

  test("the plain half may not carry a backticked token or the attribute", () => {
    expect(problemLapses({ title: "t", problem: `The \`heading-order\` rule fires on the second heading of the page here.\n\n${detail}` })).toEqual(["label-in-plain"]);
    expect(problemLapses({ title: "t", attribute: "label-gap", problem: `The label-gap between the field and its label is too small to read as one thing.\n\n${detail}` })).toEqual(["label-in-plain"]);
  });

  test("category names that are English words are not labels", () => {
    expect(problemLapses({ title: "t", attribute: "contrast", problem: `The body text has too little contrast against the card to read comfortably.\n\n${detail}` })).toEqual([]);
  });

  test("a short plain half is advice, not failure", () => {
    expect(problemLapses({ title: "t", problem: `Too faint.\n\n${detail}` })).toEqual(["plain-too-short"]);
    expect(isExplained(`Too faint.\n\n${detail}`, "t")).toBe(true);
  });

  test("a two-part problem with an ordinary sentence first is explained", () => {
    expect(problemLapses({ title: "Heading is not a heading", problem: `${plain}\n\n${detail}` })).toEqual([]);
  });
});

describe("the refuter's plain half", () => {
  test("is put above the judge's text, never in place of it", () => {
    expect(withPlainHalf(detail, plain, "t")).toBe(`${plain}\n\n${detail}`);
  });

  test("is refused when it fails the same bar: a label, too short, or too long", () => {
    expect(withPlainHalf(detail, "The `h5` is wrong and the reader cannot tell what the section is called here.", "t")).toBeNull();
    expect(withPlainHalf(detail, "Too faint.", "t")).toBeNull();
    expect(withPlainHalf(detail, "x".repeat(401), "t")).toBeNull();
    expect(withPlainHalf(detail, "   ", "t")).toBeNull();
  });
});
