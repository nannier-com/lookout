// lookout amending its own instructions, and the evidence that stops it going
// wrong.
//
// The session writing the amendment is the session that would grade it, which
// lookout's own first rule forbids. So the grading is handed to screenshots
// whose verdicts were settled when the pixels were fresh: an amendment that
// re-files something a person ruled intentional, or loses a defect the
// adversarial verifier confirmed, is rolled back and written down.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/verbs/skills.js";
import { claimsByShot, evaluateReplay, usableCases, type RegressionSet } from "../src/skills/regression.js";
import { gatherSignals } from "../src/skills/signals.js";
import { projectSkillPath, shippedSkillDir } from "../src/skills/load.js";
import { emptyBacklog, type Backlog, type BacklogFinding } from "../src/backlog/lib.js";
import { reconcileIssues } from "../src/issues/registry.js";
import type { AiFinding } from "../src/judge/engine.js";
import type { ResolvedConfig } from "../src/types.js";
// Redirects the lookout home away from the operator's. The bunfig preload
// does this for the whole suite, but it is only found when bun is run from the
// repository root, and the code under test here records incidents: importing it
// keeps that true whatever directory the run was started from.
import "./setup.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  return {
    fingerprint: "app.root.rest.desktop.dark.color-scheme.no-dark-theme",
    target: "app",
    route: "/",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "dark",
    category: "color-scheme",
    attribute: "no-dark-theme",
    severity: "high",
    status: "by-design",
    reason: "The site deliberately does not follow the OS colour scheme; the toggle is the way in.",
    title: "Dark scheme does not apply anywhere on the page",
    problem: "p",
    expected: "e",
    observed: "o",
    channel: "ai",
    confidence: "high",
    verified: true,
    acceptance: [],
    evidence: [
      {
        shotId: "web/app/root/rest/desktop/dark",
        path: "web/app/root/rest--desktop-dark.png",
        hash: "h",
        runId: "r1",
      },
    ],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

/** A project with one adjudicated finding and the screenshot that settled it. */
function project(findings: BacklogFinding[] = [finding()]): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-improve-"));
  mkdirSync(join(dir, ".lookout", "evidence", "web", "app", "root"), { recursive: true });
  writeFileSync(
    join(dir, ".lookout", "config.json"),
    JSON.stringify({ project: "demo", targets: [{ name: "app", url: "http://localhost:1" }] }),
  );
  writeFileSync(join(dir, ".lookout", "evidence", "web", "app", "root", "rest--desktop-dark.png"), "png");
  const backlog: Backlog = emptyBacklog("demo", "2026-01-01T00:00:00.000Z");
  for (const f of findings) backlog.findings[f.fingerprint] = f;
  reconcileIssues(backlog, "2026-01-01T00:00:00.000Z");
  writeFileSync(join(dir, ".lookout", "backlog.json"), JSON.stringify(backlog, null, 2));
  return {
    config: { targets: [{ name: "app", url: "http://localhost:1" }] },
    configPath: join(dir, ".lookout", "config.json"),
    projectDir: dir,
    project: "demo",
  };
}

function run(r: ResolvedConfig, sub: string): Promise<number> {
  return skills({ positionals: [sub], flags: { config: r.configPath!, model: "sonnet" } });
}

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_JUDGE_CATEGORY;
  delete process.env.MOCK_AMENDMENT;
});

describe("what the frozen set claims", () => {
  test("a by-design adjudication becomes a must-not-file, with the reason attached", () => {
    const b = emptyBacklog("demo", "t");
    const f = finding();
    b.findings[f.fingerprint] = f;
    const claims = claimsByShot(b);
    const entry = claims.get("web/app/root/rest/desktop/dark")!;
    expect(entry.case.mustNotFile).toHaveLength(1);
    expect(entry.case.mustNotFile[0]!.category).toBe("color-scheme");
    expect(entry.case.mustNotFile[0]!.why).toContain("deliberately");
    expect(entry.case.mustFile).toHaveLength(0);
  });

  test("a verified serious finding becomes a must-file", () => {
    const b = emptyBacklog("demo", "t");
    const f = finding({ status: "open", reason: null, verified: true, severity: "critical" });
    b.findings[f.fingerprint] = f;
    const entry = claimsByShot(b).get("web/app/root/rest/desktop/dark")!;
    expect(entry.case.mustFile.map((c) => c.category)).toEqual(["color-scheme"]);
  });

  test("an unverified or minor finding settles nothing", () => {
    const b = emptyBacklog("demo", "t");
    const f = finding({ status: "open", reason: null, verified: false, severity: "low" });
    b.findings[f.fingerprint] = f;
    expect(claimsByShot(b).size).toBe(0);
  });
});

describe("replaying a candidate", () => {
  const set: RegressionSet = {
    note: "",
    frozenAt: "t",
    cases: [
      {
        shotId: "s1",
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
        mustNotFile: [{ category: "color-scheme", attribute: "no-dark-theme", why: "intended" }],
        mustFile: [{ category: "contrast", attribute: "body-text", why: "confirmed" }],
      },
    ],
  };
  const ai = (category: string): AiFinding => ({
    shotId: "s1",
    category: category as AiFinding["category"],
    attribute: "whatever",
    severity: "high",
    title: "t",
    problem: "p",
    expected: "e",
    observed: "o",
    confidence: "high",
    acceptance: [],
  });

  test("clean when the settled verdicts still hold", () => {
    expect(evaluateReplay(set, [ai("contrast")])).toHaveLength(0);
  });

  test("re-filing something ruled intentional is a violation", () => {
    const v = evaluateReplay(set, [ai("contrast"), ai("color-scheme")]);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("re-filed");
    expect(v[0]!.why).toBe("intended");
  });

  test("losing a confirmed defect is a violation", () => {
    const v = evaluateReplay(set, []);
    // The confirmed one is gone AND nothing was re-filed, so exactly one.
    expect(v.map((x) => x.kind)).toEqual(["lost"]);
  });

  test("the attribute is the judge's wording and does not gate anything", () => {
    // Same category, different attribute: still counts as the defect being seen.
    expect(evaluateReplay(set, [{ ...ai("contrast"), attribute: "text-legibility" }])).toHaveLength(0);
  });
});

describe("signals", () => {
  test("a by-design reason is read as a rule this project has taught lookout", async () => {
    const r = project();
    const signals = await gatherSignals(r);
    const byDesign = signals.filter((s) => s.kind === "by-design");
    expect(byDesign).toHaveLength(1);
    expect(byDesign[0]!.skill).toBe("visual-judge");
    expect(byDesign[0]!.detail).toContain("deliberately");
  });
});

describe("improving a skill, automatically", () => {
  test("an amendment that breaks a settled verdict is rolled back and written down", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    // The candidate makes the judge file the very thing a person ruled
    // intentional on this screenshot.
    process.env.MOCK_JUDGE_CATEGORY = "color-scheme";

    expect(await run(r, "freeze")).toBe(0);
    expect(await run(r, "improve")).toBe(1);

    // Nothing was kept: the project layer is exactly as it was, which is absent.
    expect(existsSync(projectSkillPath(r, "visual-judge"))).toBe(false);
    const history = readFileSync(join(r.projectDir, ".lookout", "skills", "history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { action: string; violations?: unknown[] });
    expect(history.at(-1)!.action).toBe("rolled-back");
    expect(history.at(-1)!.violations).toHaveLength(1);
  });

  test("an amendment the frozen set still holds is applied, and bumps the version", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    // The judge files something unrelated to any settled claim.
    process.env.MOCK_JUDGE_CATEGORY = "typography";

    expect(await run(r, "freeze")).toBe(0);
    expect(await run(r, "improve")).toBe(0);

    const layer = readFileSync(projectSkillPath(r, "visual-judge"), "utf8");
    // Derived, not pinned: the point is that the layer sits one above whatever
    // lookout ships, so the composed version rises and the ledger re-judges.
    // A literal here failed every time the shipped rubric legitimately changed.
    const shipped = Number(
      /version:\s*(\d+)/.exec(
        readFileSync(join(shippedSkillDir("visual-judge"), "SKILL.md"), "utf8"),
      )![1],
    );
    expect(layer).toContain(`version: ${shipped + 1}`);
    expect(layer).toContain("The marketing hero is deliberately light in both schemes.");
    expect(layer).toMatch(/## \d{4}-\d{2}-\d{2}: /); // dated heading, so history reads
    const history = readFileSync(join(r.projectDir, ".lookout", "skills", "history.jsonl"), "utf8");
    expect(JSON.parse(history.trim().split("\n").at(-1)!).action).toBe("applied");
  });

  test("with nothing frozen to grade it, the amendment is proposed rather than applied", async () => {
    // A blocked issue is something to learn from, but an unverified finding
    // settles nothing, so there is a signal and no gate. An ungated automatic
    // edit is the one thing this must never do.
    const r = project([
      finding({
        status: "blocked",
        reason: "three attempts did not clear it",
        verified: false,
        severity: "high",
      }),
    ]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;

    expect(await run(r, "improve")).toBe(0);
    expect(existsSync(projectSkillPath(r, "visual-judge"))).toBe(false);
    expect(
      existsSync(join(r.projectDir, ".lookout", "skills", "visual-judge", "PROPOSED.md")),
    ).toBe(true);
  });

  test("a set whose screenshots are not on this machine cannot grade anything", () => {
    const r = project();
    const set: RegressionSet = {
      note: "",
      frozenAt: "t",
      cases: [
        {
          shotId: "s1",
          file: "missing.png",
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
        },
      ],
    };
    expect(usableCases(r, set)).toHaveLength(0);
  });
});
