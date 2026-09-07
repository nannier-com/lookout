// What the project declared, as the refuter is shown it: the never-file lines
// it never used to see, and (once declared) the design direction.
import { describe, expect, test } from "bun:test";
import { declaredBlock } from "../src/judge/direction.js";

describe("the declared block", () => {
  test("is empty when the project declared nothing", () => {
    expect(declaredBlock(undefined, null)).toBe("");
    expect(declaredBlock([], null)).toBe("");
  });

  test("carries the never-file lines as bullets", () => {
    const block = declaredBlock(["the marketing hero is deliberately loud", "demo avatars repeat"], null);
    expect(block).toContain("Never-file rules:");
    expect(block).toContain("- the marketing hero is deliberately loud");
    expect(block).toContain("- demo avatars repeat");
  });

  test("names the direction by its config-relative source, after the rules", () => {
    const block = declaredBlock(["one rule"], { source: 'preset "minimalist-editorial"', text: "## Declared\n\nflat cards\n" });
    expect(block.indexOf("- one rule")).toBeLessThan(block.indexOf("Declared direction"));
    expect(block).toContain('Declared direction (preset "minimalist-editorial"):');
    expect(block.endsWith("flat cards")).toBe(true);
  });
});
