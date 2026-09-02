// The collision check's decision half: which measured overlaps are defects.
//
// Overlap on its own means nothing, because a page is layers and most of them
// are meant to be. What is pinned here is the ruling: only pairs the browser
// itself confirmed at the intersection, worst first, one finding per shot.
// The exclusions that matter most (out-of-flow positioning, modals, ancestry)
// are applied while measuring and are covered by the browser test in the
// changeset's verification rather than here, because they need a real layout.
import { describe, expect, test } from "bun:test";
import { classifyCollisions, type CollisionPair } from "../src/capture/checks-collide.js";

function pair(over: Partial<CollisionPair> = {}): CollisionPair {
  return {
    topPath: "span.chip",
    topTag: "span",
    topText: "Person",
    underPath: "td > a",
    underTag: "a",
    underText: "Bobby Nannier",
    share: 0.34,
    confirmed: true,
    ...over,
  };
}

describe("ruling on measured overlaps", () => {
  test("a confirmed overlap names both sides and how much is covered", () => {
    const [f, ...rest] = classifyCollisions({ pairs: [pair()], truncated: false });
    expect(rest).toEqual([]);
    expect(f?.type).toBe("box-collision");
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain('"Person" is drawn over "Bobby Nannier"');
    expect(f?.message).toContain("34%");
    expect(f?.meta?.offenderPath).toBe("span.chip");
  });

  test("an overlap the browser could not confirm is two rectangles, not a defect", () => {
    // A box can intersect another and be painted entirely behind a third, or
    // sit outside the viewport where nothing can be hit-tested. Neither is
    // something a reader sees going wrong.
    expect(classifyCollisions({ pairs: [pair({ confirmed: false })], truncated: false })).toEqual([]);
  });

  test("the worst overlap names the finding and the rest ride in the record", () => {
    const f = classifyCollisions({
      pairs: [
        pair({ share: 0.25, topText: "small" }),
        pair({ share: 0.81, topText: "worst" }),
        pair({ share: 0.4, topText: "middling" }),
      ],
      truncated: false,
    })[0];
    expect(f?.message).toContain('"worst"');
    expect(f?.meta?.collisions).toBe(3);
    expect((f?.meta?.pairs as { topText: string }[]).map((p) => p.topText)).toEqual([
      "worst",
      "middling",
      "small",
    ]);
  });

  test("at most five pairs are named, however many were measured", () => {
    const f = classifyCollisions({
      pairs: Array.from({ length: 8 }, (_, i) => pair({ share: 0.3 + i / 100 })),
      truncated: false,
    })[0];
    expect(f?.meta?.collisions).toBe(8);
    expect((f?.meta?.pairs as unknown[]).length).toBe(5);
  });

  test("an unlabelled element is named by its tag rather than an empty quote", () => {
    const f = classifyCollisions({
      pairs: [pair({ topText: "", underText: "" })],
      truncated: false,
    })[0];
    expect(f?.message).toContain("a span is drawn over a a");
  });

  test("nothing measured means nothing filed", () => {
    expect(classifyCollisions({ pairs: [], truncated: false })).toEqual([]);
  });
});
