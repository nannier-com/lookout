// The shot inspector's pure math: sidecar boxes to percent-of-image rects,
// and the hint a person reads. The DOM half is exercised by tools/ui-check's
// drive; this holds the projection to the sidecar's own mapping contract.
import { describe, expect, test } from "bun:test";
import { hintOf, MAX_BOXES, project, type SvElement, type SvSidecar } from "../src/ui/client/shot-project.js";

function el(over: Partial<SvElement> = {}): SvElement {
  return {
    tag: "div",
    id: null,
    testid: null,
    text: null,
    cssPath: "div:nth-of-type(1)",
    box: { x: 0, y: 0, w: 100, h: 50 },
    components: [],
    ...over,
  };
}

function sidecar(elements: SvElement[], over: Partial<SvSidecar> = {}): SvSidecar {
  return {
    version: 1,
    originBox: { x: 0, y: 0, w: 1280, h: 900 },
    image: { width: 2560, height: 1800 },
    elements,
    ...over,
  };
}

describe("project", () => {
  test("document origin at dpr 2 lands as percentages of the intrinsic size", () => {
    const [b] = project(sidecar([el({ box: { x: 128, y: 90, w: 640, h: 450 } })]));
    expect(b).toMatchObject({ left: 10, top: 10, width: 50, height: 50 });
  });

  test("an element origin subtracts the crop root", () => {
    const [b] = project(
      sidecar([el({ box: { x: 150, y: 550, w: 40, h: 30 } })], {
        originBox: { x: 100, y: 500, w: 400, h: 300 },
        image: { width: 800, height: 600 },
      }),
    );
    expect(b!.left).toBeCloseTo(12.5, 10);
    expect(b!.top).toBeCloseTo(100 / 6, 10);
    expect(b!.width).toBeCloseTo(10, 10);
    expect(b!.height).toBeCloseTo(10, 10);
  });

  test("offscreen drops, straddling clamps", () => {
    const boxes = project(
      sidecar([
        el({ box: { x: 2000, y: 0, w: 100, h: 100 } }),
        el({ box: { x: -50, y: 0, w: 100, h: 100 }, id: "straddle" }),
        el({ box: { x: 0, y: 0, w: 0, h: 100 } }),
      ]),
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.el.id).toBe("straddle");
    expect(boxes[0]!.left).toBe(0);
  });

  test("a foreign version projects nothing", () => {
    expect(project(sidecar([el()], { version: 2 }))).toEqual([]);
  });

  test("the cap keeps hinted records and the order is area-descending", () => {
    const many = Array.from({ length: MAX_BOXES }, (_, i) =>
      el({ box: { x: 0, y: 0, w: 10 + (i % 7), h: 10 } }),
    );
    const sourced = el({
      source: { file: "src/A.tsx", line: 1 },
      box: { x: 0, y: 0, w: 5, h: 5 },
      id: "kept",
    });
    const boxes = project(sidecar([...many, sourced]));
    expect(boxes).toHaveLength(MAX_BOXES);
    expect(boxes.some((b) => b.el.id === "kept")).toBe(true);
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i - 1]!.width * boxes[i - 1]!.height).toBeGreaterThanOrEqual(
        boxes[i]!.width * boxes[i]!.height,
      );
    }
  });
});

describe("hintOf", () => {
  test("chain, source, handle, and what it said, in that order", () => {
    expect(
      hintOf(
        el({
          components: ["SaveButton", "Form"],
          source: { file: "src/SaveButton.tsx", line: 12 },
          tag: "button",
          id: "save",
          text: "Save changes",
        }),
      ),
    ).toBe('SaveButton < Form  src/SaveButton.tsx:12  button#save  "Save changes"');
  });

  test("falls back through testid to the cssPath", () => {
    expect(hintOf(el({ tag: "p", testid: "intro" }))).toBe('p[data-testid="intro"]');
    expect(hintOf(el({ tag: "p", cssPath: "main > p:nth-of-type(2)" }))).toBe(
      "main > p:nth-of-type(2)",
    );
    expect(hintOf(el({ components: ["Card"], tag: "div" }))).toBe("Card  div");
  });
});
