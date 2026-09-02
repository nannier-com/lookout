// The two states that are about the pointer and the keyboard.
//
// These hold the parts that decide whether a focus or hover shot is evidence
// or noise: the name says which interaction it was, hover is never attempted
// where there is no pointer, and a shot identical to its own rest twin is
// reported as the interaction doing nothing rather than left for a judge to
// infer from an image that cannot show it.
import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_FOCUS, DEFAULT_MAX_HOVER, prefixed, skipsAt } from "../src/navigate/indicate.js";
import { markIndicatorReadback } from "../src/capture/web-page.js";
import type { ShotRecord } from "../src/types.js";

function shot(over: Partial<ShotRecord> = {}): ShotRecord {
  return {
    id: "web/app/root/rest/desktop/dark",
    target: "app",
    route: "/",
    routeName: "/",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "dark",
    path: "a.png",
    hash: "h1",
    bytes: 1,
    width: 10,
    height: 10,
    animated: false,
    capturedAt: "t",
    runId: "r",
    deterministicFindings: [],
    ...over,
  };
}

describe("naming an indicator state", () => {
  test("the interaction is spelled into the name", () => {
    expect(prefixed("save-changes", "focus")).toBe("focus-save-changes");
    expect(prefixed("pricing", "hover")).toBe("hover-pricing");
  });

  test("a name the planner already prefixed is not prefixed twice", () => {
    expect(prefixed("focus-save", "focus")).toBe("focus-save");
  });

  test("a prefix that would break the 40-character cap is dropped, not truncated", () => {
    // Truncating would collide two different states into one shot id, and a
    // shot id is half of every fingerprint in the backlog.
    const long = "a".repeat(38);
    expect(prefixed(long, "focus")).toBe(long);
  });
});

describe("where hover is attempted", () => {
  test("never on a phone, which has no pointer to rest anywhere", () => {
    expect(skipsAt("hover", "phone")).toBe(true);
    expect(skipsAt("hover", "tablet")).toBe(false);
    expect(skipsAt("hover", "desktop")).toBe(false);
  });

  test("focus is a keyboard interaction, so every form factor keeps it", () => {
    for (const ff of ["phone", "tablet", "desktop"]) expect(skipsAt("focus", ff)).toBe(false);
  });

  test("one of each per route by default", () => {
    expect(DEFAULT_MAX_FOCUS).toBe(1);
    expect(DEFAULT_MAX_HOVER).toBe(1);
  });
});

describe("indicator read-back", () => {
  test("a focus shot identical to its rest twin files that nothing marks focus", () => {
    const shots = [
      shot(),
      shot({ id: "focus", state: "focus-save", interaction: "focus", hash: "h1", stateAffordance: { selector: "b", role: "button", name: "Save changes", href: null } }),
    ];
    markIndicatorReadback(shots);
    expect(shots[0]!.deterministicFindings).toHaveLength(0);
    const f = shots[1]!.deterministicFindings[0]!;
    expect(f.type).toBe("focus-invisible");
    expect(f.message).toContain("Save changes");
    expect(f.meta!.restShotId).toBe("web/app/root/rest/desktop/dark");
  });

  test("a hover shot identical to its rest twin files that hovering did nothing", () => {
    const shots = [
      shot(),
      shot({ id: "hov", state: "hover-pricing", interaction: "hover", hash: "h1", stateAffordance: { selector: "a", role: "link", name: "Pricing", href: "/p" } }),
    ];
    markIndicatorReadback(shots);
    expect(shots[1]!.deterministicFindings[0]!.type).toBe("hover-silent");
  });

  test("pixels that moved file nothing at all", () => {
    // One-sided by design: a clock or a lazy image moves pixels without the
    // interaction having done anything, so only sameness proves the negative.
    const shots = [shot(), shot({ id: "focus", state: "focus-save", interaction: "focus", hash: "h2" })];
    markIndicatorReadback(shots);
    expect(shots[1]!.deterministicFindings).toHaveLength(0);
  });

  test("the twin must be the same view, not merely the same route", () => {
    const shots = [
      shot({ scheme: "light" }),
      shot({ id: "focus", state: "focus-save", interaction: "focus", hash: "h1", scheme: "dark" }),
    ];
    markIndicatorReadback(shots);
    expect(shots[1]!.deterministicFindings).toHaveLength(0);
  });

  test("a state with no interaction is not read back at all", () => {
    const shots = [shot(), shot({ id: "ov", state: "menu-open", hash: "h1" })];
    markIndicatorReadback(shots);
    expect(shots[1]!.deterministicFindings).toHaveLength(0);
  });
});
