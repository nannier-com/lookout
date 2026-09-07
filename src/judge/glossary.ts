/**
 * The category vocabulary, said in words.
 *
 * A category is part of every fingerprint and cluster key, so its token is
 * fixed for good; what a card, a title or a report prints beside the token is
 * not. `phrase` is the noun a title uses ("2 accessibility problems on /"),
 * `gloss` the sentence a chip or a legend carries. Rubric vocabulary, so it
 * lives with the rubric, and a test holds it to the category list.
 */
import type { Category } from "./rubric.js";

export interface CategoryWords {
  /** A noun phrase that reads in "N <phrase> problems on /route". */
  phrase: string;
  /** One sentence saying what the category is about. */
  gloss: string;
}

export const CATEGORY_GLOSS: Record<Category, CategoryWords> = {
  "render-failure": {
    phrase: "rendering",
    gloss: "The screen did not draw what it should have: an error, a failed request, a blank or half-drawn capture.",
  },
  "layout-overflow": {
    phrase: "overflow",
    gloss: "Content runs past the edge of the screen or makes the page scroll sideways.",
  },
  alignment: {
    phrase: "alignment",
    gloss: "Things that should line up do not.",
  },
  spacing: {
    phrase: "spacing",
    gloss: "Gaps that are uneven, missing, or too tight to separate what they should.",
  },
  hierarchy: {
    phrase: "hierarchy",
    gloss: "Nothing on the screen reads as more important than anything else, or the wrong thing does.",
  },
  typography: {
    phrase: "typography",
    gloss: "Text that fails at its job: cut off, cramped, or set so it does not read as what it is.",
  },
  "color-scheme": {
    phrase: "colour scheme",
    gloss: "The light or dark scheme is ignored or only partly applied.",
  },
  contrast: {
    phrase: "contrast",
    gloss: "Text or controls too close in colour to what is behind them to read.",
  },
  states: {
    phrase: "interaction state",
    gloss: "A control that does nothing, or a state the screen cannot show or leave.",
  },
  responsive: {
    phrase: "responsive layout",
    gloss: "The layout does not adapt to the form factor it was photographed at.",
  },
  anatomy: {
    phrase: "control anatomy",
    gloss: "A control missing a part it is expected to have.",
  },
  consistency: {
    phrase: "consistency",
    gloss: "The same thing done two ways, or a control built by hand where the kit provides it.",
  },
  composition: {
    phrase: "composition",
    gloss: "The view as a whole reads as unfinished, however each part looks on its own.",
  },
  a11y: {
    phrase: "accessibility",
    gloss: "What somebody using a screen reader or a keyboard gets instead of what a sighted mouse user gets.",
  },
  content: {
    phrase: "content",
    gloss: "Broken copy: placeholder text, leaked values, empty labels, untranslated keys.",
  },
  "design-parity": {
    phrase: "design parity",
    gloss: "Differs from the design hand-off it was built from.",
  },
  taste: {
    phrase: "taste",
    gloss: "A default nobody chose: the palette, type, layout or copy a generic build falls into, where the project declared nothing else.",
  },
};

/** The noun a title uses for a category, falling back to the token itself. */
export function categoryPhrase(category: string): string {
  return (CATEGORY_GLOSS as Record<string, CategoryWords | undefined>)[category]?.phrase ?? category;
}
