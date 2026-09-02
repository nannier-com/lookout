// The record feed says what the document says, with the one difference a
// card has room for: a commit is shortened the way git log shortens it.
import { describe, expect, test } from "bun:test";
import { shortShas } from "../src/report/board-words.js";
import { durableTimeline } from "../src/report/board-durable.js";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("the feed's wording", () => {
  test("a forty-character commit is shortened, and nothing else is touched", () => {
    expect(shortShas(`a fix was reported at ${SHA}: rebuilt`)).toBe("a fix was reported at a1b2c3d: rebuilt");
    expect(shortShas("issue 418203 at deadbee")).toBe("issue 418203 at deadbee");
  });

  test("the claimed step carries the short sha; the verdict step is untouched", () => {
    const steps = durableTimeline(
      { id: "1", attempts: [{ n: 1, dispatchedAt: "2026-09-01T10:00:00Z", reported: { commit: SHA, note: "rebuilt" }, verdict: "still-open", judgeNote: "still there" }] },
      "2026-09-01T09:00:00Z",
    );
    expect(steps.map((s) => s.text)).toEqual([
      "lookout filed this issue",
      "a fix was reported at a1b2c3d: rebuilt",
      "lookout ruled it still-open: still there",
    ]);
  });
});
