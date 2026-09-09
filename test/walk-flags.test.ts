// What a walk may spend, from flags that are always strings.
import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_NAVIGATOR_CALLS, navigatorOf, walkCaps } from "../src/check/walk-flags.js";
import { DEFAULT_JUDGE_MODEL, PRIMARY_AI } from "../src/judge/engine.js";

const parsed = (flags: Record<string, string | boolean>) => ({ positionals: [], flags });

describe("walkCaps", () => {
  test("the defaults: every screen, twenty navigator calls, no budget, replay first, the judge model", () => {
    expect(walkCaps(parsed({}))).toEqual({
      first: false,
      maxScreens: null,
      maxNavigatorCalls: DEFAULT_MAX_NAVIGATOR_CALLS,
      budgetUsd: null,
      navigator: { ai: PRIMARY_AI, model: DEFAULT_JUDGE_MODEL },
      replay: "first",
      screens: undefined,
    });
  });

  test("number flags arrive as strings; a bare flag or a word is refused rather than defaulted", () => {
    expect(walkCaps(parsed({ "max-screens": "3", "max-navigator-calls": "5", "budget-usd": "1.5" }))).toMatchObject({ maxScreens: 3, maxNavigatorCalls: 5, budgetUsd: 1.5 });
    expect(() => walkCaps(parsed({ "max-screens": true }))).toThrow(/--max-screens needs a number/);
    expect(() => walkCaps(parsed({ "budget-usd": "lots" }))).toThrow(/--budget-usd needs a number/);
  });

  test("replay flags: --no-replay re-records, --replay-only never spends, both is a contradiction", () => {
    expect(walkCaps(parsed({ "no-replay": true })).replay).toBe("never");
    expect(walkCaps(parsed({ "replay-only": true })).replay).toBe("only");
    expect(() => walkCaps(parsed({ "no-replay": true, "replay-only": true }))).toThrow(/contradict/);
  });

  test("the navigator model follows --model, or --navigator-model in the challenger's spelling", () => {
    expect(walkCaps(parsed({ model: "opus" })).navigator).toEqual({ ai: PRIMARY_AI, model: "opus" });
    expect(navigatorOf("haiku", "opus")).toEqual({ ai: PRIMARY_AI, model: "haiku" });
    expect(navigatorOf("codex:gpt-5.5", undefined)).toEqual({ ai: "codex", model: "gpt-5.5" });
    expect(() => navigatorOf("gemini:x", undefined)).toThrow(/no AI adapter/);
    expect(() => navigatorOf("codex:", undefined)).toThrow(/names no model/);
    expect(walkCaps(parsed({ first: true, screens: "a|/|rest,b|/|rest" }))).toMatchObject({ first: true, screens: ["a|/|rest", "b|/|rest"] });
  });
});
