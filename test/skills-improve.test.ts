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
import { evidenceDir } from "../src/config.js";
import { skills } from "../src/verbs/skills.js";
import {
  claimsByShot,
  casesAsShots,
  freezeRegressionSet,
  usableCases,
  type RegressionSet,
} from "../src/skills/regression.js";
import { evaluateReplay } from "../src/skills/verdict.js";
import { loadBacklog } from "../src/verbs/backlog.js";
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

/**
 * Scope is somebody else's subject. The tests below are about which VERDICTS
 * settle a claim, so they hand the selection a predicate that never narrows;
 * the one test that is about scope builds a real config and lets `freeze`
 * derive it.
 */
const anyScope = (): boolean => true;

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

/**
 * The same settled finding, on a route the config does not name any more.
 *
 * Its screenshot is still in the evidence workspace: pruning drops a shot from
 * the capture REPORT and leaves the PNG, because backlog findings still point
 * at it. So file existence proves nothing about scope.
 */
function staleFinding(): BacklogFinding {
  return finding({
    fingerprint: "app.gone.rest.desktop.dark.color-scheme.no-dark-theme",
    route: "/gone",
    evidence: [
      {
        shotId: "web/app/gone/rest/desktop/dark",
        path: "web/app/gone/rest--desktop-dark.png",
        hash: "h",
        runId: "r1",
      },
    ],
  });
}

/** A project with one adjudicated finding and the screenshot that settled it. */
function project(findings: BacklogFinding[] = [finding()]): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-improve-"));
  const evDir = evidenceDir({ projectDir: dir } as ResolvedConfig);
  mkdirSync(join(evDir, "web", "app", "root"), { recursive: true });
  writeFileSync(
    join(dir, "lookout.config.json"),
    JSON.stringify({ project: "demo", targets: [{ name: "app", url: "http://localhost:1" }] }),
  );
  writeFileSync(join(evDir, "web", "app", "root", "rest--desktop-dark.png"), "png");
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const backlog: Backlog = emptyBacklog("demo", "2026-01-01T00:00:00.000Z");
  for (const f of findings) backlog.findings[f.fingerprint] = f;
  reconcileIssues(backlog, "2026-01-01T00:00:00.000Z");
  writeFileSync(join(dir, ".lookout", "backlog.json"), JSON.stringify(backlog, null, 2));
  return {
    config: { targets: [{ name: "app", url: "http://localhost:1" }] },
    configPath: join(dir, "lookout.config.json"),
    projectDir: dir,
    project: "demo",
  };
}

function run(r: ResolvedConfig, sub: string, flags: Record<string, unknown> = {}): Promise<number> {
  return skills({ positionals: [sub], flags: { config: r.configPath!, model: "sonnet", ...flags } });
}

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_JUDGE_CATEGORY;
  delete process.env.MOCK_JUDGE_ONLY_WITH;
  delete process.env.MOCK_JUDGE_SILENT_WITH;
  delete process.env.MOCK_JUDGE_FLAKY_FILE;
  delete process.env.MOCK_AMENDMENT;
});

describe("what the frozen set claims", () => {
  test("a by-design adjudication becomes a must-not-file, with the reason attached", () => {
    const b = emptyBacklog("demo", "t");
    const f = finding();
    b.findings[f.fingerprint] = f;
    const claims = claimsByShot(b, anyScope);
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
    const entry = claimsByShot(b, anyScope).get("web/app/root/rest/desktop/dark")!;
    expect(entry.case.mustFile.map((c) => c.category)).toEqual(["color-scheme"]);
  });

  test("a verified medium becomes a must-file too, now the refuter reaches it", () => {
    // Every AI finding gets the refuting pass since the boundary was removed,
    // so a confirmed medium is a claim the frozen set can actually hold.
    const b = emptyBacklog("demo", "t");
    const f = finding({ status: "open", reason: null, verified: true, severity: "medium" });
    b.findings[f.fingerprint] = f;
    const entry = claimsByShot(b, anyScope).get("web/app/root/rest/desktop/dark")!;
    expect(entry.case.mustFile).toHaveLength(1);
  });

  test("a verified design-parity finding settles nothing", () => {
    // Frozen cases carry no design reference, so no replay can ever re-file a
    // design-parity divergence: freezing one would put an unsatisfiable
    // mustFile in the gate and roll back every future amendment as "lost".
    const b = emptyBacklog("demo", "t");
    const f = finding({
      status: "open",
      reason: null,
      verified: true,
      severity: "high",
      category: "design-parity",
      attribute: "hero-width",
    });
    b.findings[f.fingerprint] = f;
    expect(claimsByShot(b, anyScope).size).toBe(0);
  });

  test("a deterministic measurement settles nothing about the judge", () => {
    // The replay never re-takes the measurements (the frozen shots carry no
    // signals) and the rubric forbids the judge restating one, so an axe
    // violation must not freeze into a mustFile no judge is allowed to
    // satisfy: that claim reads as "lost" on every replay and rolls back
    // every amendment. Deterministic findings arrive verified at high or
    // medium severity, which is exactly the mustFile filter.
    const b = emptyBacklog("demo", "t");
    const axe = finding({
      status: "open",
      reason: null,
      channel: "deterministic",
      category: "a11y",
      attribute: "axe-region",
      severity: "high",
      verified: true,
    });
    b.findings[axe.fingerprint] = axe;
    expect(claimsByShot(b, anyScope).size).toBe(0);
    // A by-design measurement stays out too: the person ruled on the check's
    // output, not on the judge's visual net, and the judge never filed it, so
    // there is nothing an amendment could "bring back".
    const b2 = emptyBacklog("demo", "t");
    const overflow = finding({
      channel: "deterministic",
      category: "layout-overflow",
      attribute: "horizontal-scroll",
      status: "by-design",
      reason: "the carousel scrolls sideways on purpose",
      verified: true,
    });
    b2.findings[overflow.fingerprint] = overflow;
    expect(claimsByShot(b2, anyScope).size).toBe(0);
  });

  test("an unverified finding settles nothing, and neither does a verified low", () => {
    // Lows stay out on purpose: they are the most judge-variant claims and the
    // least costly to miss, and the frozen set is a gate that fails amendments
    // on replay misses. Admitting them would make the improve gate flaky in
    // exchange for protecting the cheapest findings.
    const b = emptyBacklog("demo", "t");
    const unverified = finding({ status: "open", reason: null, verified: false, severity: "low" });
    b.findings[unverified.fingerprint] = unverified;
    expect(claimsByShot(b, anyScope).size).toBe(0);
    const b2 = emptyBacklog("demo", "t");
    const low = finding({ status: "open", reason: null, verified: true, severity: "low" });
    b2.findings[low.fingerprint] = low;
    expect(claimsByShot(b2, anyScope).size).toBe(0);
  });

  test("a settled finding for a route the config dropped settles nothing, pixels or not", async () => {
    // The cap is on screenshots, so a claim about a screen the app no longer
    // serves does not just sit there harmlessly: it spends one of twenty slots
    // that a live screen could have had, and it can never be retired, because
    // `check` no longer looks at that route and so never re-adjudicates it.
    // The only thing that used to keep these out was the PNG happening to be
    // gone, and prune leaves the PNG behind on purpose.
    const r = project([finding(), staleFinding()]);
    const evDir = evidenceDir(r);
    mkdirSync(join(evDir, "web", "app", "gone"), { recursive: true });
    writeFileSync(join(evDir, "web", "app", "gone", "rest--desktop-dark.png"), "png");

    expect(await run(r, "freeze")).toBe(0);

    const set = JSON.parse(
      readFileSync(join(r.projectDir, ".lookout", "regression", "manifest.json"), "utf8"),
    ) as RegressionSet;
    expect(set.cases.map((c) => c.route)).toEqual(["/"]);
    // And the evidence is still there: the fix is the scope check, not deleting
    // files the backlog still references.
    expect(existsSync(join(evDir, "web", "app", "gone", "rest--desktop-dark.png"))).toBe(true);

    // Dropped out loud. An empty-or-thinner set has two very different causes,
    // and "nothing settled yet" is the wrong thing to say about verdicts that
    // were settled on screens the config stopped naming.
    const again = await freezeRegressionSet(r, await loadBacklog(r), "t");
    expect(again.outOfScope).toBe(1);
    expect(again.set.cases).toHaveLength(1);
  });

  test("a case carries what was measured on its shot, and the sidecar beside it", async () => {
    // The refuter reads both in production. A gate that replays without them
    // grades an amendment under evidence the real run does not have, which is
    // not grading the real run.
    const r = project();
    const evDir = evidenceDir(r);
    const rel = join("web", "app", "root", "rest--desktop-dark.png");
    writeFileSync(join(evDir, `${rel}.provenance.json`), JSON.stringify({ version: 1, elements: [] }));
    writeFileSync(join(evDir, `${rel}.aria.json`), JSON.stringify({ version: 1, yaml: '- button "Save"', hash: "a1" }));
    writeFileSync(
      join(evDir, "capture-report.json"),
      JSON.stringify({
        version: 1,
        project: "demo",
        createdAt: "t",
        updatedAt: "t",
        runs: [],
        shots: [
          {
            id: "web/app/root/rest/desktop/dark",
            target: "app",
            route: "/",
            routeName: "root",
            state: "rest",
            platform: "web",
            formFactor: "desktop",
            scheme: "dark",
            path: rel,
            hash: "h",
            bytes: 1,
            width: 1,
            height: 1,
            animated: false,
            capturedAt: "t",
            runId: "run-1",
            scrollers: [{ path: "div", tag: "div", width: 390, hiddenWidth: 900 }],
            deterministicFindings: [
              { type: "edge-clipped", severity: "error", message: '"Account" is cut off' },
            ],
          },
        ],
      }),
    );

    const { set } = await freezeRegressionSet(r, await loadBacklog(r), "t");
    const c = set.cases[0]!;
    expect(c.deterministicFindings?.[0]?.type).toBe("edge-clipped");
    expect(c.scrollers?.[0]?.hiddenWidth).toBe(900);
    expect(c.provenance).toBe(true);
    expect(existsSync(join(r.projectDir, ".lookout", "regression", "shots", `${c.file}.provenance.json`))).toBe(true);
    // The accessibility tree too. The integrity and text panels are GIVEN it in
    // production, so a set frozen without it grades those two under evidence
    // they never actually judge on.
    expect(c.aria).toBe(true);
    expect(existsSync(join(r.projectDir, ".lookout", "regression", "shots", `${c.file}.aria.json`))).toBe(true);

    // And they reach the replay's shot records, which is the whole point.
    const [replayed] = casesAsShots(set);
    expect(replayed?.deterministicFindings).toHaveLength(1);
    expect(replayed?.provenance).toContain(".provenance.json");
    expect(replayed?.aria).toContain(".aria.json");
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
    region: "content",
    severity: "high",
    title: "t",
    problem: "p",
    expected: "e",
    observed: "o",
    confidence: "high",
    acceptance: [],
  });

  test("clean when the settled verdicts still hold", () => {
    expect(evaluateReplay(set, [ai("contrast")]).violations).toHaveLength(0);
  });

  test("re-filing something ruled intentional is a violation", () => {
    const v = evaluateReplay(set, [ai("contrast"), ai("color-scheme")]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("re-filed");
    expect(v[0]!.why).toBe("intended");
  });

  test("losing a confirmed defect is a violation", () => {
    const v = evaluateReplay(set, []).violations;
    // The confirmed one is gone AND nothing was re-filed, so exactly one.
    expect(v.map((x: { kind: string }) => x.kind)).toEqual(["lost"]);
    expect(v[0]!.panel).toBe("judge-visibility");
  });

  test("the attribute is the judge's wording and does not gate anything", () => {
    // Same category, different attribute: still counts as the defect being seen.
    const v = evaluateReplay(set, [{ ...ai("contrast"), attribute: "text-legibility" }]);
    expect(v.violations).toHaveLength(0);
  });

  test("a sibling category from the same panel satisfies the claim, and is reported", () => {
    // The measured failure this matching exists for: on unchanged skills the
    // panel finds the defect but labels it with another of its own categories.
    // contrast and a11y are both judge-visibility, so the claim is met.
    const v = evaluateReplay(set, [ai("a11y")]);
    expect(v.violations).toHaveLength(0);
    expect(v.drift).toHaveLength(1);
    expect(v.drift[0]!.category).toBe("contrast");
    expect(v.drift[0]!.filed).toEqual(["a11y"]);
    expect(v.drift[0]!.panel).toBe("judge-visibility");
  });

  test("a category from ANOTHER panel does not satisfy the claim", () => {
    // typography is judge-text. The visibility panel said nothing about this
    // shot, so the confirmed defect really is lost.
    const v = evaluateReplay(set, [ai("typography")]);
    expect(v.violations.map((x: { kind: string }) => x.kind)).toEqual(["lost"]);
    expect(v.drift).toHaveLength(0);
  });

  test("a suppressed category is NOT forgiven by a sibling in its lane", () => {
    // The asymmetry: widening must-not-file would call every unrelated finding
    // the panel makes on this shot a re-file. a11y is not the suppressed
    // color-scheme, so nothing was re-filed.
    const v = evaluateReplay(set, [ai("contrast"), ai("a11y")]);
    expect(v.violations).toHaveLength(0);
  });

  test("the panel recorded at freeze time is what decides the lane", () => {
    const recorded: RegressionSet = {
      ...set,
      cases: [
        {
          ...set.cases[0]!,
          mustFile: [
            { category: "contrast", attribute: "body-text", panel: "judge-visibility", why: "c" },
          ],
        },
      ],
    };
    expect(evaluateReplay(recorded, [ai("a11y")]).violations).toHaveLength(0);
    // A stale name falls back to today's owner rather than losing the lane.
    const stale: RegressionSet = {
      ...set,
      cases: [
        {
          ...set.cases[0]!,
          mustFile: [{ category: "contrast", attribute: "b", panel: "judge-gone", why: "c" }],
        },
      ],
    };
    expect(evaluateReplay(stale, [ai("a11y")]).violations).toHaveLength(0);
  });
});

describe("signals", () => {
  test("a by-design reason is read as a rule this project has taught lookout", async () => {
    const r = project();
    const signals = await gatherSignals(r);
    const byDesign = signals.filter((s) => s.kind === "by-design");
    expect(byDesign).toHaveLength(1);
    // The fixture's finding is VERIFIED: a person overruled the adversarial
    // verifier's explicit confirmation, so the lesson is the refuter's, not
    // the judge's. An unverified by-design still attributes to judge-core
    // (pinned in test/watermark.test.ts).
    expect(byDesign[0]!.skill).toBe("refute-finding");
    expect(byDesign[0]!.detail).toContain("deliberately");
  });

  test("a shot a panel ruled on in neither list is a lesson for that panel", async () => {
    // The count of these has always been reported. What the panel dropped, and
    // that its own prose sometimes describes the very shot it left out, is
    // what makes the lesson actionable.
    const r = project();
    writeFileSync(
      join(evidenceDir(r), "judge-report.json"),
      JSON.stringify({
        runId: "check-1",
        unaccounted: [
          { panel: "judge-craft", groupId: "app|web|/|rest", shotIds: ["web/app/root/rest/phone/light", "web/app/root/rest/tablet/light"] },
          { panel: "judge-craft", groupId: "app|web|/settings|rest", shotIds: ["web/app/settings/rest/phone/dark"] },
          { panel: "judge-text", groupId: "app|web|/|rest", shotIds: ["web/app/root/rest/phone/dark"] },
        ],
        findings: [
          {
            shotId: "web/app/root/rest/desktop/light",
            title: "The activity table is cut off at the phone width",
            problem: "Also visible in web/app/root/rest/phone/light.",
          },
        ],
      }),
    );
    const skipped = (await gatherSignals(r)).filter((s) => s.kind === "skipped");
    // One per panel per run, not one per call: a reply that dropped three
    // shots dropped them under one set of instructions.
    expect(skipped.map((s) => s.skill).sort()).toEqual(["judge-craft", "judge-text"]);
    const craft = skipped.find((s) => s.skill === "judge-craft")!;
    expect(craft.summary).toContain("3 shot(s)");
    expect(craft.detail).toContain("web/app/settings/rest/phone/dark");
    // The panel described a shot it never listed: the case the contract is for.
    expect(craft.detail).toContain("The activity table is cut off at the phone width");
    // Same run, same panel, same key: a second gather does not re-teach it.
    expect(new Set(skipped.map((s) => s.key)).size).toBe(2);
  });

  test("a by-design on a measurement teaches nothing; a skill-found hand-roll teaches the conformance skill", async () => {
    // Deterministic findings are born verified: true because the measurement
    // is its own evidence. The refuter never saw this finding, so ruling it
    // intentional must not become the refuter's lesson (or, via the pair
    // rule, license amending the judge either).
    const measurement = finding({
      fingerprint: "det.fp",
      channel: "deterministic",
      verified: true,
      category: "a11y",
      attribute: "axe-color-contrast",
      reason: "Brand colours fail the ratio on purpose; the a11y toggle is the way in.",
    });
    const scanFound = finding({
      fingerprint: "code.scan.fp",
      channel: "code",
      verified: false,
      category: "consistency",
      attribute: "hand-rolled",
      reason: "Allowed bespoke.",
      source: { path: "/x/App.tsx", relPath: "App.tsx", symbol: "App", line: 1, foundBy: "scan" },
    });
    const skillFound = finding({
      fingerprint: "code.skill.fp",
      channel: "code",
      verified: false,
      category: "consistency",
      attribute: "hand-rolled",
      reason: "The root frame is app scaffolding with no kit equivalent.",
      source: { path: "/x/Frame.tsx", relPath: "Frame.tsx", symbol: "Frame", line: 1, foundBy: "skill" },
    });
    const r = project([measurement, scanFound, skillFound]);
    const byDesign = (await gatherSignals(r)).filter((s) => s.kind === "by-design");
    // Only the skill-found hand-roll emits: the person overruled the
    // conformance skill's own claim. The measurement and the scanner's claim
    // are the project's tolerance for checks no amendable skill controls.
    expect(byDesign).toHaveLength(1);
    expect(byDesign[0]!.skill).toBe("kit-conformance");
    expect(byDesign[0]!.source).toBe("code.skill.fp");
    expect(byDesign[0]!.detail).not.toContain("verifier");
  });
});

describe("improving a skill, automatically", () => {
  test("an amendment that breaks a settled verdict is rolled back and written down", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    // The candidate makes the judge file the very thing a person ruled
    // intentional on this screenshot, and ONLY the candidate does: the gate
    // controls for the violation by re-judging with the amendment withdrawn,
    // so a judge that re-filed either way would be a stale claim rather than a
    // rollback.
    process.env.MOCK_JUDGE_CATEGORY = "color-scheme";
    process.env.MOCK_JUDGE_ONLY_WITH = "deliberately light in both schemes";

    expect(await run(r, "freeze")).toBe(0);
    expect(await run(r, "improve")).toBe(1);

    // Nothing was kept: the project layer is exactly as it was, which is absent.
    expect(existsSync(projectSkillPath(r, "judge-core"))).toBe(false);
    const history = readFileSync(join(r.projectDir, ".lookout", "skills", "history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { action: string; violations?: unknown[] });
    expect(history.at(-1)!.action).toBe("rolled-back");
    expect(history.at(-1)!.violations).toHaveLength(1);
  });

  test("an amendment that BLINDS the panel is rolled back too", async () => {
    // The other direction, and the one the gate's confirmation could mask if it
    // retried until the judge got lucky: the candidate silences the panel on
    // every call, so the confirmed defect is lost every round, and the control
    // round brings it straight back.
    const r = project([
      finding({
        fingerprint: "app.root.contrast.body-text",
        category: "contrast",
        attribute: "body-text",
        status: "open",
        reason: null,
        verified: true,
        severity: "high",
      }),
      finding(),
    ]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_CATEGORY = "contrast";
    process.env.MOCK_JUDGE_SILENT_WITH = "deliberately light in both schemes";

    expect(await run(r, "freeze")).toBe(0);
    expect(await run(r, "improve")).toBe(1);

    expect(existsSync(projectSkillPath(r, "judge-core"))).toBe(false);
    const history = readFileSync(join(r.projectDir, ".lookout", "skills", "history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { action: string; violations?: { kind: string }[] });
    expect(history.at(-1)!.action).toBe("rolled-back");
    expect(history.at(-1)!.violations!.map((v) => v.kind)).toEqual(["lost"]);
  });

  test("an amendment the frozen set still holds is applied, and bumps the version", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    // The judge files something unrelated to any settled claim.
    process.env.MOCK_JUDGE_CATEGORY = "typography";

    expect(await run(r, "freeze")).toBe(0);
    expect(await run(r, "improve")).toBe(0);

    const layer = readFileSync(projectSkillPath(r, "judge-core"), "utf8");
    // Derived, not pinned: the point is that the layer sits one above whatever
    // lookout ships, so the composed version rises and the ledger re-judges.
    // A literal here failed every time the shipped rubric legitimately changed.
    const shipped = Number(
      /version:\s*(\d+)/.exec(
        readFileSync(join(shippedSkillDir("judge-core"), "SKILL.md"), "utf8"),
      )![1],
    );
    expect(layer).toContain(`version: ${shipped + 1}`);
    expect(layer).toContain("The marketing hero is deliberately light in both schemes.");
    expect(layer).toMatch(/## \d{4}-\d{2}-\d{2}: /); // dated heading, so history reads
    const history = readFileSync(join(r.projectDir, ".lookout", "skills", "history.jsonl"), "utf8");
    expect(JSON.parse(history.trim().split("\n").at(-1)!).action).toBe("applied");
  });

  test("an amendment can land on the panel the evidence licensed", async () => {
    // The fixture's by-design is a verified color-scheme finding: the lesson
    // is the refuter's, licensing judge-visibility (the confirmed claim's
    // owner) alongside. The amendment targets the panel, applies into its own
    // layer, and history records it under the panel's name.
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_IMPROVE_SKILL = "judge-visibility";
    process.env.MOCK_JUDGE_CATEGORY = "typography";
    try {
      expect(await run(r, "freeze")).toBe(0);
      expect(await run(r, "improve")).toBe(0);
      const layer = readFileSync(projectSkillPath(r, "judge-visibility"), "utf8");
      expect(layer).toContain("name: judge-visibility");
      expect(layer).toContain("The marketing hero is deliberately light in both schemes.");
      const history = readFileSync(join(r.projectDir, ".lookout", "skills", "history.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { action: string; skill: string });
      expect(history.at(-1)).toMatchObject({ action: "applied", skill: "judge-visibility" });
    } finally {
      delete process.env.MOCK_IMPROVE_SKILL;
      delete process.env.MOCK_JUDGE_CATEGORY;
    }
  });

  test("with nothing frozen to grade it, spending is opt-in and produces a proposal", async () => {
    // A blocked issue is something to learn from, but an unverified finding
    // settles nothing, so there is a signal and no gate. An ungated automatic
    // edit is the one thing this must never do; and since the best possible
    // outcome is an unapplied PROPOSED.md, the model call itself now needs
    // the explicit --propose. Without it: no spend, no file, and the message
    // says which switch buys the proposal.
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
    expect(
      existsSync(join(r.projectDir, ".lookout", "skills", "judge-core", "PROPOSED.md")),
    ).toBe(false);

    expect(await run(r, "improve", { propose: true })).toBe(0);
    expect(existsSync(projectSkillPath(r, "judge-core"))).toBe(false);
    expect(
      existsSync(join(r.projectDir, ".lookout", "skills", "judge-core", "PROPOSED.md")),
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

// Consumption, the attribution constraint, the auto pre-gate, and the bridge:
// the machinery phase that makes an automatic trigger safe to add.
describe("what an improve consumes and refuses", () => {
  test("a second improve over an unchanged record makes zero model calls", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const argvFile = join(r.projectDir, ".lookout", "improve-argv.jsonl");
    process.env.MOCK_ARGV_FILE = argvFile;
    try {
      expect(await run(r, "freeze")).toBe(0);
      expect(await run(r, "improve")).toBe(0);
      const callsAfterFirst = readFileSync(argvFile, "utf8").trim().split("\n").length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      // Same record, second pass: the watermark says nothing is new, and the
      // model is never invoked.
      expect(await run(r, "improve")).toBe(0);
      const callsAfterSecond = readFileSync(argvFile, "utf8").trim().split("\n").length;
      expect(callsAfterSecond).toBe(callsAfterFirst);
    } finally {
      delete process.env.MOCK_ARGV_FILE;
    }
  });

  test("an amendment naming a skill the signals never indicted is refused", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_IMPROVE_SKILL = "fact-check";
    try {
      expect(await run(r, "freeze")).toBe(0);
      await expect(run(r, "improve")).rejects.toThrow(/names fact-check/);
    } finally {
      delete process.env.MOCK_IMPROVE_SKILL;
    }
  });

  test("judging signals license the core and the refuter, never a sibling panel", async () => {
    // The fixture's signals indict the judging family; the pair rule adds the
    // core and the refuter, but a specialist panel the evidence never touched
    // stays off limits.
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_IMPROVE_SKILL = "judge-craft";
    try {
      expect(await run(r, "freeze")).toBe(0);
      await expect(run(r, "improve")).rejects.toThrow(/names judge-craft/);
    } finally {
      delete process.env.MOCK_IMPROVE_SKILL;
    }
  });

  test("the auto path never spends on a proposal-only outcome", async () => {
    const { improveSkills } = await import("../src/skills/amend.js");
    const r = project([
      finding({ status: "blocked", reason: "stuck", verified: false, severity: "high" }),
    ]);
    process.env.LOOKOUT_CLAUDE_BIN = join(import.meta.dir, "no-such-claude-binary");
    // No frozen cases exist: a manual run would need --propose; the auto run
    // must simply skip, spending nothing (the dead binary proves no call).
    expect(await improveSkills(r, "sonnet", { auto: true })).toBe(0);
  });

  test("a rollback records a skill-rollback incident in this project's log", async () => {
    const { clusterIncidents, readIncidents } = await import("../src/skills/incidents.js");
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_AMENDMENT = "- File every deliberately light surface as a defect.";
    process.env.MOCK_JUDGE_CATEGORY = "color-scheme";
    // Only the candidate re-files it; see the rollback test above.
    process.env.MOCK_JUDGE_ONLY_WITH = "light surface as a defect";
    try {
      expect(await run(r, "freeze")).toBe(0);
      expect(await run(r, "improve")).toBe(1);
      const groups = clusterIncidents(readIncidents(r.projectDir));
      expect(groups.some((g) => g.kind === "skill-rollback")).toBe(true);
    } finally {
      delete process.env.MOCK_AMENDMENT;
    }
  });
});
