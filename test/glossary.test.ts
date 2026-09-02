// The category vocabulary in words. The token is identity and fixed; the
// words beside it are what a title or a chip prints, and every category has
// them or a card would print a bare token for it.
import { describe, expect, test } from "bun:test";
import { CATEGORIES } from "../src/judge/rubric.js";
import { CATEGORY_GLOSS, categoryPhrase } from "../src/judge/glossary.js";

describe("every category has its words", () => {
  test("the glossary covers the vocabulary exactly", () => {
    expect(Object.keys(CATEGORY_GLOSS).sort()).toEqual([...CATEGORIES].sort());
    for (const [category, words] of Object.entries(CATEGORY_GLOSS)) {
      expect({ category, phrase: words.phrase.length > 0, gloss: words.gloss.length > 20 }).toEqual({ category, phrase: true, gloss: true });
      // The phrase is a noun that reads in "N <phrase> problems on /route".
      expect({ category, hyphenated: words.phrase.includes("-") }).toEqual({ category, hyphenated: false });
    }
  });

  test("an unknown token falls back to itself rather than to nothing", () => {
    expect(categoryPhrase("a11y")).toBe("accessibility");
    expect(categoryPhrase("something-new")).toBe("something-new");
  });
});
