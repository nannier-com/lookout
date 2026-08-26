// The verdict rule. These are the cases where being wrong means the oracle
// closes a defect nobody fixed, or blames a fix session for a defect it never
// caused, so they are worth stating explicitly.
import { describe, expect, test } from "bun:test";
import { ruleVerdict } from "../src/fix/rule.js";

const base = { attempt: 1, maxAttempts: 2, changedShots: 3, stillOpen: 0, regressions: 0 };

describe("ruleVerdict", () => {
  test("a real fix passes", () => {
    expect(ruleVerdict(base)).toBe("passed");
  });

  test("the defect still showing sends it back", () => {
    expect(ruleVerdict({ ...base, stillOpen: 2 })).toBe("still-open");
  });

  test("a new critical defect on changed pixels is a regression", () => {
    expect(ruleVerdict({ ...base, regressions: 1 })).toBe("regressed");
  });

  test("nothing passes on unchanged pixels, however clean the judge came back", () => {
    // The judge is not deterministic. If no screenshot moved, an empty finding
    // list means it read the same image differently today, not that anything
    // was fixed. Passing here would let variance alone close real defects.
    expect(ruleVerdict({ ...base, changedShots: 0 })).toBe("still-open");
    expect(ruleVerdict({ ...base, changedShots: 0, stillOpen: 0, regressions: 0 })).toBe("still-open");
  });

  test("unchanged pixels on the last attempt block rather than pass", () => {
    expect(ruleVerdict({ ...base, attempt: 2, changedShots: 0 })).toBe("blocked");
  });

  test("the last attempt blocks instead of bouncing back", () => {
    expect(ruleVerdict({ ...base, attempt: 2, stillOpen: 1 })).toBe("blocked");
    expect(ruleVerdict({ ...base, attempt: 2, regressions: 1 })).toBe("blocked");
  });

  test("a genuine fix on the last attempt still passes", () => {
    expect(ruleVerdict({ ...base, attempt: 2 })).toBe("passed");
  });
});
