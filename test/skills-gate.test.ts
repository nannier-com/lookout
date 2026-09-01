// The improve gate's answer to a stochastic judge.
//
// A replay is one sample. Measured on a 63-claim frozen set with the skills
// completely unchanged, two replays lost 6 and 22 settled claims, so a gate
// that rolls back on any single-sample difference rolls back everything for
// ever and reports it as the amendment's fault. These tests pin the two things
// that stop that without loosening the check: a violation has to reproduce
// before it counts, and what reproduces has to survive a control round with
// the candidate withdrawn.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, CONFIRM_ATTEMPTS } from "../src/skills/gate.js";
import type { RegressionCase, RegressionSet } from "../src/skills/regression.js";
import type { ResolvedConfig } from "../src/types.js";
import "./setup.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_JUDGE_CATEGORY;
  delete process.env.MOCK_JUDGE_ONLY_WITH;
  delete process.env.MOCK_JUDGE_FLAKY_FILE;
  delete process.env.MOCK_ARGV_FILE;
});

function frozen(mustFile: RegressionCase["mustFile"]): {
  resolved: ResolvedConfig;
  set: RegressionSet;
} {
  const dir = mkdtempSync(join(tmpdir(), "lookout-gate-"));
  mkdirSync(join(dir, ".lookout", "regression", "shots"), { recursive: true });
  writeFileSync(
    join(dir, "lookout.config.json"),
    JSON.stringify({ project: "demo", targets: [{ name: "app", url: "http://localhost:1" }] }),
  );
  writeFileSync(join(dir, ".lookout", "regression", "shots", "s1.png"), "png");
  const set: RegressionSet = {
    note: "",
    frozenAt: "2026-01-01T00:00:00.000Z",
    cases: [
      {
        shotId: "web/app/root/rest/desktop/dark",
        file: "s1.png",
        target: "app",
        route: "/",
        routeName: "/",
        state: "rest",
        formFactor: "desktop",
        scheme: "dark",
        platform: "web",
        width: 0,
        height: 1,
        mustNotFile: [],
        mustFile,
      },
    ],
  };
  return {
    resolved: {
      config: { targets: [{ name: "app", url: "http://localhost:1" }] },
      configPath: join(dir, "lookout.config.json"),
      projectDir: dir,
      project: "demo",
    },
    set,
  };
}

const CLAIM = { category: "contrast", attribute: "body-text", panel: "judge-visibility", why: "c" };

/** A control that records whether it was asked for, and answers unamended. */
function control(): {
  withoutCandidate: <T>(fn: () => Promise<T>) => Promise<T>;
  ran: () => number;
} {
  let calls = 0;
  return {
    withoutCandidate: async (fn) => {
      calls++;
      return await fn();
    },
    ran: () => calls,
  };
}

describe("a violation has to reproduce", () => {
  test("a one-off miss is the judge's spread, not a broken verdict", async () => {
    // The judge goes quiet on its first call and files normally after. Under
    // the old rule that single sample was a rollback.
    const { resolved, set } = frozen([CLAIM]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_CATEGORY = "contrast";
    process.env.MOCK_JUDGE_FLAKY_FILE = join(resolved.projectDir, "quiet-once");

    const c = control();
    const out = await runGate(resolved, set, "sonnet", {
      amendedSkill: "judge-visibility",
      withoutCandidate: c.withoutCandidate,
    });

    expect(out.violations).toHaveLength(0);
    expect(out.unreproduced).toHaveLength(1);
    expect(out.unreproduced[0]!.kind).toBe("lost");
    // Nothing survived to control for, so the control was never spent on.
    expect(c.ran()).toBe(0);
    expect(out.rounds).toBe(2);
  });

  test("a defect the candidate really lost reproduces every round", async () => {
    // The candidate silences the judge on every call. Withdrawing it brings the
    // finding back, which is exactly what a real blinding amendment looks like:
    // lost under the candidate, held without it.
    const { resolved, set } = frozen([CLAIM]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_CATEGORY = "contrast";
    process.env.MOCK_JUDGE_ONLY_WITH = "no-such-marker-in-any-prompt";

    let controlRuns = 0;
    const out = await runGate(resolved, set, "sonnet", {
      amendedSkill: "judge-visibility",
      withoutCandidate: async (fn) => {
        controlRuns++;
        delete process.env.MOCK_JUDGE_ONLY_WITH;
        try {
          return await fn();
        } finally {
          process.env.MOCK_JUDGE_ONLY_WITH = "no-such-marker-in-any-prompt";
        }
      },
    });

    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]!.kind).toBe("lost");
    expect(out.violations[0]!.panel).toBe("judge-visibility");
    expect(out.stale).toHaveLength(0);
    expect(controlRuns).toBe(1);
    // Every confirmation attempt, then the control.
    expect(out.rounds).toBe(CONFIRM_ATTEMPTS + 1);
  });
});

describe("what reproduces still has to beat the control", () => {
  test("a claim the unchanged skills also lose is stale, not the amendment's fault", async () => {
    // The judge is silent with or without the candidate: the frozen claim has
    // stopped being reproducible at all. Blaming the amendment for ground that
    // was already lost is the silent failure this gate exists to end.
    const { resolved, set } = frozen([CLAIM]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_CATEGORY = "contrast";
    process.env.MOCK_JUDGE_ONLY_WITH = "no-such-marker-in-any-prompt";

    const c = control();
    const out = await runGate(resolved, set, "sonnet", {
      amendedSkill: "judge-visibility",
      // Withdrawing the candidate changes nothing about what the judge says:
      // the unchanged skills lose the claim too.
      withoutCandidate: c.withoutCandidate,
    });
    expect(out.stale).toHaveLength(1);
    expect(out.stale[0]!.category).toBe("contrast");
    expect(out.violations).toHaveLength(0);
    expect(c.ran()).toBe(1);
  });
});

describe("the drift the matching now forgives is still written down", () => {
  test("a sibling category satisfies the claim and is reported", async () => {
    // a11y and contrast are both judge-visibility. The panel found something
    // on the shot, so the claim holds; the label moved, so it is reported.
    const { resolved, set } = frozen([CLAIM]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_CATEGORY = "a11y";

    const c = control();
    const out = await runGate(resolved, set, "sonnet", {
      amendedSkill: "judge-visibility",
      withoutCandidate: c.withoutCandidate,
    });

    expect(out.violations).toHaveLength(0);
    expect(out.drift).toHaveLength(1);
    expect(out.drift[0]!.category).toBe("contrast");
    expect(out.drift[0]!.filed).toEqual(["a11y"]);
    expect(c.ran()).toBe(0);
    // One replay: nothing was in dispute.
    expect(out.rounds).toBe(1);
  });

  test("a clean replay costs exactly one pass", async () => {
    const { resolved, set } = frozen([CLAIM]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_CATEGORY = "contrast";
    const argv = join(resolved.projectDir, "argv.jsonl");
    process.env.MOCK_ARGV_FILE = argv;

    const c = control();
    const out = await runGate(resolved, set, "sonnet", {
      amendedSkill: "judge-visibility",
      withoutCandidate: c.withoutCandidate,
    });

    expect(out.violations).toHaveLength(0);
    expect(out.rounds).toBe(1);
    // One judge call and one refuter call, and not a token more: confirmation
    // and control are only spent when something is actually in dispute.
    expect(existsSync(argv)).toBe(true);
    expect(readFileSync(argv, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
