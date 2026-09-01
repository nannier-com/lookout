// The pure half of the affordance harvest: selector ranking, exclusion,
// naming, and the signature's stability rules. The in-page collector is
// exercised by the real-verb fixture run, not here (no browser in the suite).
import { describe, expect, test } from "bun:test";
import {
  chooseSelector,
  normalizeRaw,
  signatureOf,
  type RawAffordance,
} from "../src/navigate/harvest.js";

function raw(over: Partial<RawAffordance> = {}): RawAffordance {
  return {
    tag: "button",
    role: "button",
    name: "Open menu",
    id: null,
    testid: null,
    cssPath: "div:nth-of-type(1) > button:nth-of-type(1)",
    href: null,
    inForm: false,
    submit: false,
    excluded: false,
    box: { x: 0, y: 0, w: 100, h: 40 },
    ...over,
  };
}

describe("selector ranking", () => {
  test("id beats testid beats the nth-of-type path", () => {
    expect(chooseSelector(raw({ id: "menu", testid: "m" }))).toBe('[id="menu"]');
    expect(chooseSelector(raw({ testid: "menu-btn" }))).toBe('[data-testid="menu-btn"]');
    expect(chooseSelector(raw())).toBe("div:nth-of-type(1) > button:nth-of-type(1)");
  });
});

describe("normalization", () => {
  test("drops in-page exclusions and accessible-name substring matches", () => {
    const affs = normalizeRaw(
      [
        raw({ name: "Open menu" }),
        raw({ name: "Sign out of workspace" }),
        raw({ name: "Delete", excluded: true }),
      ],
      ["sign OUT"],
    );
    expect(affs.map((a) => a.name)).toEqual(["Open menu"]);
  });

  test("truncates names to 80 chars and numbers ids in document order", () => {
    const affs = normalizeRaw([raw({ name: "x".repeat(200) }), raw({ name: "Second" })], []);
    expect(affs[0]!.name).toHaveLength(80);
    expect(affs.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

describe("the signature", () => {
  test("stable under reordering and layout jitter", () => {
    const a = normalizeRaw([raw({ name: "A" }), raw({ name: "B", href: "http://x.test/b" })], []);
    const b = normalizeRaw(
      [
        raw({ name: "B", href: "http://x.test/b?utm=1", box: { x: 500, y: 9, w: 10, h: 10 } }),
        raw({ name: "A", cssPath: "main:nth-of-type(1) > button:nth-of-type(3)" }),
      ],
      [],
    );
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("changes when a control appears or renames", () => {
    const base = normalizeRaw([raw({ name: "A" })], []);
    expect(signatureOf(normalizeRaw([raw({ name: "A" }), raw({ name: "New" })], []))).not.toBe(
      signatureOf(base),
    );
    expect(signatureOf(normalizeRaw([raw({ name: "Renamed" })], []))).not.toBe(signatureOf(base));
  });
});
