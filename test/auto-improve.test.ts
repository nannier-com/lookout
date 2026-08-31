// The automatic learning trigger's decision, pinned as a table: it must be
// impossible for a run to auto-spend when any decline, lock, cooldown, or
// evidence rule says no, and impossible for a fresh by-design ruling to wait.
import { describe, expect, test } from "bun:test";
import { shouldAutoImprove, DEFAULT_THRESHOLD } from "../src/skills/auto-improve.js";

const ready = {
  configured: true,
  declined: false,
  ci: false,
  improveLockHeld: false,
  healLockHeld: false,
  lastImproveAt: null,
  cooldownHours: 24,
  now: "2026-08-31T12:00:00.000Z",
  newCount: DEFAULT_THRESHOLD,
  newByDesign: 0,
  threshold: DEFAULT_THRESHOLD,
};

describe("when a run auto-learns", () => {
  test("enough new signals fire it; one fewer does not", () => {
    expect(shouldAutoImprove(ready).run).toBe(true);
    expect(shouldAutoImprove({ ...ready, newCount: DEFAULT_THRESHOLD - 1 }).run).toBe(false);
  });

  test("a single new by-design adjudication fires alone", () => {
    expect(shouldAutoImprove({ ...ready, newCount: 1, newByDesign: 1 }).run).toBe(true);
  });

  test("every decline wins: flag or config, CI, either lock, no config file", () => {
    expect(shouldAutoImprove({ ...ready, declined: true }).run).toBe(false);
    expect(shouldAutoImprove({ ...ready, ci: true }).run).toBe(false);
    expect(shouldAutoImprove({ ...ready, improveLockHeld: true }).run).toBe(false);
    expect(shouldAutoImprove({ ...ready, healLockHeld: true }).run).toBe(false);
    expect(shouldAutoImprove({ ...ready, configured: false }).run).toBe(false);
  });

  test("the cooldown holds and then releases", () => {
    const withRecent = { ...ready, lastImproveAt: "2026-08-31T00:00:00.000Z" };
    expect(shouldAutoImprove(withRecent).run).toBe(false);
    expect(shouldAutoImprove({ ...withRecent, cooldownHours: 6 }).run).toBe(true);
  });

  test("every refusal says why", () => {
    for (const args of [
      { ...ready, newCount: 0 },
      { ...ready, declined: true },
      { ...ready, ci: true },
      { ...ready, healLockHeld: true },
    ]) {
      const d = shouldAutoImprove(args);
      expect(d.run).toBe(false);
      expect(d.skipped).toBeTruthy();
    }
  });
});
