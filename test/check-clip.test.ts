// The clip check's decision half: which measured protrusions are defects.
//
// The in-page half measures and decides nothing; everything that rules lives in
// classifyClips, so the whole judgement is testable without a browser. What is
// pinned here is mostly what it must stay SILENT about: content inside a
// scroller is reachable, a truncated label truncates on purpose, and a hidden
// helper is hidden on purpose. A check that files those buries the real clip.
import { describe, expect, test } from "bun:test";
import { classifyClips, type ClipCandidate, type ClipHarvest } from "../src/capture/check-clip.js";

function candidate(over: Partial<ClipCandidate> = {}): ClipCandidate {
  return {
    path: "header > button:nth-of-type(2)",
    tag: "button",
    text: "Account",
    clipper: "viewport",
    clipperPath: "",
    overRight: 43,
    overBottom: 0,
    scrollable: false,
    excused: false,
    ...over,
  };
}

const harvest = (candidates: ClipCandidate[]): ClipHarvest => ({
  candidates,
  scrollers: [],
  truncated: false,
});

describe("what counts as clipped", () => {
  test("content past the viewport with nothing to scroll is filed, with the element named", () => {
    const [f, ...rest] = classifyClips(harvest([candidate()]));
    expect(rest).toEqual([]);
    expect(f?.type).toBe("edge-clipped");
    expect(f?.severity).toBe("error");
    expect(f?.meta?.clipper).toBe("viewport");
    expect(f?.message).toContain('"Account"');
    expect(f?.message).toContain("43px");
    expect(f?.meta?.offenderPath).toBe("header > button:nth-of-type(2)");
  });

  test("content past a box that hides its overflow is a different defect from the viewport's", () => {
    const findings = classifyClips(
      harvest([
        candidate(),
        candidate({ clipper: "ancestor", clipperPath: "div.panel", path: "td", tag: "td", text: "Last seen", overRight: 88 }),
      ]),
    );
    // Two findings, not one: a header that clips at the window edge and a panel
    // that clips its own content are different fixes in different files.
    expect(findings.map((f) => f.meta?.clipper)).toEqual(["viewport", "ancestor"]);
  });

  test("the worst offender names the finding and the rest ride in the record", () => {
    const f = classifyClips(
      harvest([
        candidate({ text: "small", overRight: 4 }),
        candidate({ text: "worst", overRight: 120, path: "a" }),
        candidate({ text: "middling", overRight: 40, path: "b" }),
      ]),
    )[0];
    expect(f?.message).toContain('"worst"');
    expect(f?.message).toContain("120px");
    expect(f?.meta?.clipped).toBe(3);
    expect((f?.meta?.offenders as { text: string }[]).map((o) => o.text)).toEqual(["worst", "middling", "small"]);
  });

  test("at most five offenders are named, however many were measured", () => {
    const f = classifyClips(
      harvest(Array.from({ length: 9 }, (_, i) => candidate({ path: `e${i}`, overRight: 10 + i }))),
    )[0];
    expect(f?.meta?.clipped).toBe(9);
    expect((f?.meta?.offenders as unknown[]).length).toBe(5);
  });

  test("a clip below the bottom edge is described as such", () => {
    const f = classifyClips(harvest([candidate({ clipper: "ancestor", overRight: 0, overBottom: 30 })]))[0];
    expect(f?.message).toContain("below the bottom edge");
    expect(f?.message).toContain("30px");
  });

  test("an unlabelled element is named by its tag rather than by an empty quote", () => {
    const f = classifyClips(harvest([candidate({ text: "" })]))[0];
    expect(f?.message).toStartWith("A button extends");
  });
});

describe("what it must stay silent about", () => {
  test("content inside a horizontal scroller is reachable, not lost", () => {
    expect(classifyClips(harvest([candidate({ scrollable: true })]))).toEqual([]);
  });

  test("a label that truncates on purpose is not a defect", () => {
    expect(classifyClips(harvest([candidate({ excused: true })]))).toEqual([]);
  });

  test("one excused element does not silence a real one beside it", () => {
    const findings = classifyClips(
      harvest([candidate({ excused: true, overRight: 300 }), candidate({ path: "real", text: "Save" })]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"Save"');
    // The excused one is not counted either: it is not clipped, it is styled.
    expect(findings[0]?.meta?.clipped).toBe(1);
  });

  test("nothing measured means nothing filed", () => {
    expect(classifyClips(harvest([]))).toEqual([]);
  });
});
