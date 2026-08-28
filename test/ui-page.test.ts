// The ui page's client script is inside a template literal, so no tool in the
// build sees it.
//
// tsc type-checks the file around it and eslint lints the file around it, and
// both walk straight past several hundred lines of JavaScript held as a string.
// A single mis-escaped character in there emits a broken token into the served
// script, the browser throws on load, and the whole page quietly stops working
// while every gate stays green. That happened; this is the guard.
import { describe, expect, test } from "bun:test";
import { PAGE } from "../src/verbs/ui.js";

/** The contents of every <script> block in the page. */
function scripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe("the served page", () => {
  test("has a client script", () => {
    const found = scripts(PAGE).filter((s) => s.trim().length > 0);
    expect(found.length).toBeGreaterThan(0);
    // Guard the guard: if the page stops carrying real logic, this test would
    // pass vacuously and prove nothing.
    expect(found.join("\n")).toContain("function");
  });

  test("every script parses as JavaScript", () => {
    for (const [i, src] of scripts(PAGE).entries()) {
      // Function() compiles without executing, which is exactly the check the
      // browser does on load and nothing in the build does at all.
      expect(() => new Function(src), `script #${i} does not parse`).not.toThrow();
    }
  });
});
