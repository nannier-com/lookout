// The skills say what to judge; they never say who is judging.
//
// This is a rule that decays silently. Every one of these files is prose, any
// of them can be edited by hand or amended by lookout itself, and a sentence
// naming one vendor's tool reads perfectly well right up until a second AI is
// handed the same file and told to use a tool it does not have. So the rule is
// a test rather than a convention.
//
// The one sentence that legitimately differs between AIs is how to open a
// screenshot, and that is exactly why it is a placeholder: each adapter fills
// `{{howToOpen}}` with its own words, and `renderSkill` throws rather than
// letting an unfilled one reach a model.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../src/judge/adapters.js";

const SKILLS = new URL("../skills/", import.meta.url).pathname;

/** Every shipped instruction file, including the includes and the directions. */
function skillFiles(dir = SKILLS): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return skillFiles(p);
    return p.endsWith(".md") ? [p] : [];
  });
}

/**
 * Words that name a vendor, a vendor's product, or one CLI's tool.
 *
 * The tool names are the ones Claude Code uses, because those are the ones
 * that were in these files and would come back the same way. `view_image` is
 * here for the same reason from the other direction: Codex's vocabulary has no
 * more business in a shared instruction file than Claude's does.
 */
const VENDOR = /\b(claude|anthropic|codex|openai|gemini|gpt|chatgpt|copilot)\b/i;
const TOOL_NAMES = /\b(the Read tool|the view_image tool|the Bash tool|the Grep tool|the Glob tool|the Edit tool|the Write tool)\b/i;

/** Frontmatter comments are lookout's own notes and never reach a model. */
function body(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

describe("the skills are agnostic about who is reading them", () => {
  test("there are skills to check", () => {
    expect(skillFiles().length).toBeGreaterThan(10);
  });

  test("no shipped instruction names a vendor or a vendor's product", () => {
    const offenders = skillFiles()
      .map((p) => [p, body(readFileSync(p, "utf8"))] as const)
      .filter(([, text]) => VENDOR.test(text))
      .map(([p]) => p.slice(SKILLS.length));
    expect(offenders).toEqual([]);
  });

  test("and none names one CLI's tool", () => {
    const offenders = skillFiles()
      .map((p) => [p, body(readFileSync(p, "utf8"))] as const)
      .filter(([, text]) => TOOL_NAMES.test(text))
      .map(([p]) => p.slice(SKILLS.length));
    expect(offenders).toEqual([]);
  });

  test("the skills that ask for a screenshot use the placeholder instead", () => {
    // Named rather than counted. A count has to be bumped whenever a skill
    // legitimately starts asking for a screenshot, which makes the edit look
    // like arithmetic; a list makes it look like what it is, a new skill
    // joining the set that needs a reader's own vocabulary.
    const withSlot = skillFiles()
      .filter((p) => readFileSync(p, "utf8").includes("{{howToOpen}}"))
      .map((p) => p.slice(SKILLS.length).replace(/\/SKILL\.md$/, ""))
      .sort();
    expect(withSlot).toEqual([
      "fact-check",
      "judge-challenge",
      "judge-core",
      "plan-navigation",
      "refute-finding",
      "verify-acceptance",
    ]);
  });

  test("and every registered AI can fill it", () => {
    for (const a of ADAPTERS) {
      expect(a.readingInstruction.length).toBeGreaterThan(0);
      // The sentence goes straight into a skill, so it must not smuggle a
      // vendor's name back into a file this suite just cleaned.
      expect(VENDOR.test(a.readingInstruction)).toBe(false);
    }
  });
});
