// The verdict rule. These are the cases where being wrong means the oracle
// closes a defect nobody fixed, or blames a fix session for a defect it never
// caused, so they are worth stating explicitly.
import { describe, expect, test } from "bun:test";
import { ruleVerdict } from "../src/fix/rule.js";

const base = { attempt: 1, maxAttempts: 2, changedShots: 3, stillOpen: 0, unmetCriteria: 0 };

describe("ruleVerdict", () => {
  test("a real fix passes", () => {
    expect(ruleVerdict(base)).toBe("passed");
  });

  test("the defect still showing sends it back", () => {
    expect(ruleVerdict({ ...base, stillOpen: 2 })).toBe("still-open");
  });

  test("a defect the fix caused elsewhere is not this issue's failure", () => {
    // It becomes its own issue, with its own number. Charging it here blocked
    // issues whose defect had actually been fixed.
    expect(ruleVerdict(base)).toBe("passed");
  });

  test("an acceptance criterion the evidence disproves sends it back", () => {
    expect(ruleVerdict({ ...base, unmetCriteria: 1 })).toBe("still-open");
    expect(ruleVerdict({ ...base, attempt: 2, unmetCriteria: 1 })).toBe("blocked");
  });

  test("a criterion the pixels cannot decide does not block a pass", () => {
    // not-verifiable never reaches this input: counting it would make an issue
    // whose criterion is undecidable impossible to close.
    expect(ruleVerdict({ ...base, unmetCriteria: 0 })).toBe("passed");
  });

  test("nothing passes on unchanged pixels, however clean the judge came back", () => {
    // The judge is not deterministic. If no screenshot moved, an empty finding
    // list means it read the same image differently today, not that anything
    // was fixed. Passing here would let variance alone close real defects.
    expect(ruleVerdict({ ...base, changedShots: 0 })).toBe("still-open");
    expect(ruleVerdict({ ...base, changedShots: 0, stillOpen: 0, unmetCriteria: 0 })).toBe("still-open");
  });

  test("unchanged pixels on the last attempt block rather than pass", () => {
    expect(ruleVerdict({ ...base, attempt: 2, changedShots: 0 })).toBe("blocked");
  });

  test("the last attempt blocks instead of bouncing back", () => {
    expect(ruleVerdict({ ...base, attempt: 2, stillOpen: 1 })).toBe("blocked");
  });

  test("a genuine fix on the last attempt still passes", () => {
    expect(ruleVerdict({ ...base, attempt: 2 })).toBe("passed");
  });
});
