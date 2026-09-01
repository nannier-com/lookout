// The frozen-set replay is the improve gate's courtroom, and its verdicts only
// mean anything if the pipeline it runs is the one `check` runs. These tests
// pin the two fidelity decisions: the refuter runs once per view-group batch,
// exactly as production does, and the judge is deliberately NOT shown the
// "ALREADY FILED" aid, because rebuilding it from the frozen claims would put
// the gate's own answer key into the prompt.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayRegression } from "../src/skills/replay.js";
import type { RegressionCase, RegressionSet } from "../src/skills/regression.js";
import type { ResolvedConfig } from "../src/types.js";
// Redirects the lookout home away from the operator's: the mock judge's
// contract-breaking finding records an incident on every call.
import "./setup.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

function frozenCase(over: Partial<RegressionCase>): RegressionCase {
  return {
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
    mustFile: [],
    ...over,
  };
}

/** A project whose frozen set is exactly the given cases, pixels included. */
function frozenProject(cases: RegressionCase[]): { resolved: ResolvedConfig; set: RegressionSet } {
  const dir = mkdtempSync(join(tmpdir(), "lookout-replay-"));
  mkdirSync(join(dir, ".lookout", "regression", "shots"), { recursive: true });
  writeFileSync(
    join(dir, "lookout.config.json"),
    JSON.stringify({ project: "demo", targets: [{ name: "app", url: "http://localhost:1" }] }),
  );
  for (const c of cases) {
    writeFileSync(join(dir, ".lookout", "regression", "shots", c.file), "png");
  }
  const resolved: ResolvedConfig = {
    config: { targets: [{ name: "app", url: "http://localhost:1" }] },
    configPath: join(dir, "lookout.config.json"),
    projectDir: dir,
    project: "demo",
  };
  return { resolved, set: { note: "", frozenAt: "2026-01-01T00:00:00.000Z", cases } };
}

/**
 * Two view groups, each with a must-file claim the mock judge re-files on the
 * first shot of every judge call. The mock refuter confirms only index 0 of
 * each call it receives, so the outcome says how the findings were batched:
 * refuted per view group (as `check` refutes, one call per judged batch), both
 * survive; collected into one call, the second batch's finding arrives as #1
 * and dies, and the gate reports a defect "lost" that production would keep.
 */
const TWO_GROUPS = [
  frozenCase({
    mustFile: [{ category: "contrast", attribute: "body-text", why: "confirmed" }],
  }),
  frozenCase({
    shotId: "web/app/settings/rest/desktop/dark",
    file: "s2.png",
    route: "/settings",
    routeName: "/settings",
    mustFile: [{ category: "contrast", attribute: "body-text", why: "confirmed" }],
  }),
];

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_ARGV_FILE;
});

describe("replay fidelity to the production pipeline", () => {
  test("the refuter runs once per view-group batch, as check runs it", async () => {
    const { resolved, set } = frozenProject(TWO_GROUPS);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const argvFile = join(resolved.projectDir, "argv.jsonl");
    process.env.MOCK_ARGV_FILE = argvFile;

    const outcome = await replayRegression(resolved, set, "sonnet");

    // Both confirmed defects were re-found and both survived refutation:
    // nothing was lost to a context shape production never uses.
    expect(outcome.violations).toEqual([]);
    expect(outcome.findings.map((f) => f.shotId).sort()).toEqual([
      "web/app/root/rest/desktop/dark",
      "web/app/settings/rest/desktop/dark",
    ]);

    // The plumbing agrees with the outcome: two judged batches, two refuter
    // calls, each holding a single finding at index 0.
    const prompts = readFileSync(argvFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as string[]).join(" "));
    const refutes = prompts.filter((p) => p.includes("adversarial verifier"));
    expect(refutes).toHaveLength(2);
    for (const p of refutes) {
      expect(p).toContain("#0 ");
      expect(p).not.toContain("#1 ");
    }
  });

  test("the judge is never shown the ALREADY FILED aid", async () => {
    // Deliberate divergence from `check`, pinned so closing it is a decision
    // rather than a drive-by: production's aid lists the backlog's open
    // findings so the judge keeps their attribute names, but the gate matches
    // on category alone, and an aid rebuilt from the frozen claims would list
    // every must-file answer and instruct the judge to re-file it. A blinded
    // candidate could then pass the "lost" check by parroting the list.
    const { resolved, set } = frozenProject(TWO_GROUPS);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const argvFile = join(resolved.projectDir, "argv.jsonl");
    process.env.MOCK_ARGV_FILE = argvFile;

    await replayRegression(resolved, set, "sonnet");

    const prompts = readFileSync(argvFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as string[]).join(" "));
    const judges = prompts.filter((p) => p.includes("- shotId: "));
    expect(judges.length).toBeGreaterThan(0);
    for (const p of judges) {
      expect(p).not.toContain("ALREADY FILED");
    }
  });
});
