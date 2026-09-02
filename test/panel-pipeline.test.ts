// The (view group x panel) work unit, driven with stub two-panel registries:
// one panel failing leaves its sibling's verdict standing, a specialist
// filing outside its lane is rejected, a group is only clean when every
// panel ruled, the refuter runs pooled once per group, --panels narrows who
// judges without hiding whose verdicts are cached, and a repair to one
// panel's entry never evicts a sibling's cached findings.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeInBatches } from "../src/check/batches.js";
import { recordOutcome } from "../src/check/outcome.js";
import { planJudging, type JudgePlan, type PanelWork } from "../src/check/plan.js";
import { reverifyCached } from "../src/check/reverify.js";
import { evidenceDir } from "../src/config.js";
import { groupHash, ledgerKey, panelIdentity, saveLedger, loadLedger, type PanelIdentity } from "../src/judge/ledger.js";
import { viewGroupId } from "../src/judge/grouping.js";
import { loadJudges, type PanelRubric } from "../src/judge/rubric.js";
import { loadSkill } from "../src/skills/load.js";
import type { VerifiedFinding } from "../src/judge/verify.js";
import { tmpProject } from "./tmp-project.js";
import { LookoutError, type ResolvedConfig, type ShotRecord } from "../src/types.js";
import type { CheckScope } from "../src/check/scope.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");
const refute = await loadSkill(tmpProject("lookout-panel-pipe-"), "refute-finding");

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_MODE;
  delete process.env.MOCK_FAIL_PANEL;
  delete process.env.MOCK_JUDGE_CATEGORY;
  delete process.env.MOCK_ARGV_FILE;
  delete process.env.MOCK_JUDGE_SIBLINGS;
  delete process.env.MOCK_VERIFY_CONFIRM_ALL;
  delete process.env.MOCK_SKIP_LAST;
  delete process.env.MOCK_VERIFY;
});

function shot(id: string): ShotRecord {
  const [platform, target, routeSlug, state, formFactor, scheme] = id.split("/");
  return {
    id,
    target: target!,
    route: `/${routeSlug}`,
    routeName: routeSlug!,
    state: state!,
    platform: platform as ShotRecord["platform"],
    formFactor: formFactor as ShotRecord["formFactor"],
    scheme: scheme as ShotRecord["scheme"],
    path: `${id}.png`,
    hash: `hash-${id}`,
    bytes: 1,
    width: 100,
    height: 100,
    animated: false,
    capturedAt: "2026-08-25T00:00:00Z",
    runId: "test",
    deterministicFindings: [],
  };
}

/** A stub panel whose prompt advertises exactly its own vocabulary. */
function stubPanel(name: string, categories: readonly string[], extra = ""): PanelRubric {
  const bullets = categories.map((c) => `- ${c}: the ${c} bullet.`).join("\n");
  return {
    def: { name, categories: categories as PanelRubric["def"]["categories"] },
    text: `${extra}## Category vocabulary\n\n${bullets}\n\n## Shots\n{{manifest}}\n{{priorFindings}}`,
    version: 1,
    handoff: "",
  };
}

function identityOf(p: PanelRubric): PanelIdentity {
  return panelIdentity({
    panel: p.def.name,
    version: p.version,
    panelText: p.text,
    refuteText: refute.text,
    handoffText: p.handoff,
    model: "sonnet",
  });
}

function planOf(panels: PanelRubric[], groups: ShotRecord[][], over: Partial<JudgePlan> = {}): JudgePlan {
  const toJudge: PanelWork[] = [];
  for (const group of groups) {
    for (const panel of panels) {
      toJudge.push({ panel, identity: identityOf(panel), groupId: viewGroupId(group[0]!), shots: group });
    }
  }
  return {
    panels,
    refute,
    model: "sonnet",
    ledger: { note: "", entries: {} },
    identities: new Map(panels.map((p) => [p.def.name, identityOf(p)])),
    toJudge,
    toJudgeShots: groups.flat(),
    cachedFindings: [],
    cached: 0,
    prior: [],
    ...over,
  } as JudgePlan;
}

function project(): ResolvedConfig {
  const r = tmpProject("lookout-panel-pipe-");
  mkdirSync(evidenceDir(r), { recursive: true });
  return r;
}

const silent = (): void => {};
const drive = (r: ResolvedConfig, plan: JudgePlan, shots: ShotRecord[]) =>
  judgeInBatches({
    resolved: r,
    plan,
    shotsById: new Map(shots.map((s) => [s.id, s])),
    parsed: { positionals: [], flags: {} },
    log: silent,
    opts: {},
  });

describe("per-panel isolation", () => {
  test("one panel failing leaves the sibling's verdict standing and cached", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"], "FAIL-THIS-PANEL\n");
    const b = stubPanel("panel-b", ["spacing"]);
    const plan = planOf([a, b], [[s]]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_FAIL_PANEL = "FAIL-THIS-PANEL";

    const pass = await drive(r, plan, [s]);
    expect(pass.failedBatches).toEqual([
      { panel: "panel-a", shots: 1, message: expect.stringContaining("") as unknown as string },
    ]);
    expect(pass.uncacheable.has(`${viewGroupId(s)}|panel-a`)).toBe(true);
    expect(pass.uncacheable.has(`${viewGroupId(s)}|panel-b`)).toBe(false);
    expect(pass.confirmed.map((f) => f.category)).toEqual(["spacing"]);

    const outcome = await recordOutcome({
      resolved: r,
      scope: { shots: [s] } as CheckScope,
      plan,
      pass,
      log: silent,
    });
    // The surviving panel's verdict is real and recorded; the failed one is
    // simply absent, to be judged again next run.
    const back = await loadLedger(r);
    expect(back.entries[ledgerKey(groupHash([s]), identityOf(b))]?.verdict).toBe("findings");
    expect(back.entries[ledgerKey(groupHash([s]), identityOf(a))]).toBeUndefined();
    expect(outcome.unjudged).toBe(1);
    expect(outcome.panels).toEqual(["panel-a", "panel-b"]);
  });

  test("every panel call failing is fatal; one of two is not", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"], "FAIL-THIS-PANEL\n");
    const b = stubPanel("panel-b", ["spacing"], "FAIL-THIS-PANEL\n");
    const plan = planOf([a, b], [[s]]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_FAIL_PANEL = "FAIL-THIS-PANEL";

    const pass = await drive(r, plan, [s]);
    expect(pass.failedBatches).toHaveLength(2);
    expect(pass.batchCount).toBe(2);
    await expect(
      recordOutcome({ resolved: r, scope: { shots: [s] } as CheckScope, plan, pass, log: silent }),
    ).rejects.toThrow(LookoutError);
  });
});

describe("shots a defect was seen on, not merely mentioned in", () => {
  test("a named sibling is judged, refutable on its own, and lets the pair cache", async () => {
    const r = project();
    const group = ["desktop", "phone"].map((ff) => shot(`web/app/home/rest/${ff}/dark`));
    const a = stubPanel("panel-a", ["contrast"]);
    const plan = planOf([a], [group]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_SIBLINGS = "1";

    const pass = await drive(r, plan, group);
    // The judge filed on the first shot and named the second. Both are ruled
    // on, and the default refuter kills the second: a sibling is a claim about
    // its own shot, not a rider on somebody else's verdict.
    expect(pass.uncacheable.size).toBe(0);
    expect(pass.confirmed.map((f) => f.shotId)).toEqual([group[0]!.id]);
    expect(pass.refuted.map((f) => f.shotId)).toEqual([group[1]!.id]);

    const outcome = await recordOutcome({
      resolved: r,
      scope: { shots: group } as CheckScope,
      plan,
      pass,
      log: silent,
    });
    // The whole point: no shot is left unruled, so the verdict is cacheable
    // and the panel call is not re-bought on the next run.
    expect(outcome.unjudged).toBe(0);
    const back = await loadLedger(r);
    expect(back.entries[ledgerKey(groupHash(group), identityOf(a))]?.verdict).toBe("findings");
  });

  test("when every sibling stands, each shot carries its own finding", async () => {
    const r = project();
    const group = ["desktop", "phone"].map((ff) => shot(`web/app/home/rest/${ff}/dark`));
    const a = stubPanel("panel-a", ["contrast"]);
    const plan = planOf([a], [group]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_SIBLINGS = "1";
    process.env.MOCK_VERIFY_CONFIRM_ALL = "1";

    const pass = await drive(r, plan, group);
    expect(pass.confirmed.map((f) => f.shotId).sort()).toEqual(group.map((s) => s.id).sort());
    // One defect, one name: the copies keep the primary's lane and attribute,
    // which is what the cluster key fuses back into a single issue.
    expect(new Set(pass.confirmed.map((f) => `${f.category}/${f.attribute}`)).size).toBe(1);
    expect(pass.confirmed.filter((f) => f.siblingOf).map((f) => f.siblingOf)).toEqual([group[0]!.id]);
  });

  test("a shot still ruled on in neither list names its panel in the report", async () => {
    // Not every judge will honour the contract every time. When one skips a
    // shot, the run has always counted it; the report now says which panel and
    // which shots, which is the only form the learning loop can act on.
    const r = project();
    const group = ["desktop", "phone"].map((ff) => shot(`web/app/home/rest/${ff}/dark`));
    const a = stubPanel("panel-a", ["contrast"]);
    const plan = planOf([a], [group]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_SKIP_LAST = "1";

    const pass = await drive(r, plan, group);
    expect(pass.unaccounted).toEqual([
      { panel: "panel-a", groupId: viewGroupId(group[0]!), shotIds: [group[1]!.id] },
    ]);

    const outcome = await recordOutcome({
      resolved: r,
      scope: { shots: group } as CheckScope,
      plan,
      pass,
      log: silent,
    });
    expect(outcome.unjudged).toBe(2);
    const written = JSON.parse(readFileSync(outcome.reportPath, "utf8")) as {
      unaccounted: { panel: string; shotIds: string[] }[];
    };
    expect(written.unaccounted).toHaveLength(1);
    expect(written.unaccounted[0]!.panel).toBe("panel-a");
    expect(written.unaccounted[0]!.shotIds).toEqual([group[1]!.id]);
  });
});

describe("names minted this run", () => {
  test("what one group filed reaches the next group's judge", async () => {
    // The prior list is built once, before judging, from the backlog. Nothing
    // told a group what the groups before it had just filed, so one defect
    // could be minted under a different attribute on every route of a single
    // run: several issues, several fix sessions, one fix.
    const r = project();
    const first = [shot("web/app/home/rest/desktop/dark")];
    const second = [shot("web/app/settings/rest/desktop/dark")];
    const a = stubPanel("panel-a", ["contrast"]);
    const plan = planOf([a], [first, second]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_ARGV_FILE = join(evidenceDir(r), "argv.txt");
    // One worker, so the two groups are strictly ordered and the second can
    // actually see what the first filed.
    await judgeInBatches({
      resolved: r,
      plan,
      shotsById: new Map([...first, ...second].map((s) => [s.id, s])),
      // A string, because that is what a flag is: num() ignores anything else,
      // and with the default two workers both groups judge at once and neither
      // can see what the other filed.
      parsed: { positionals: [], flags: { concurrency: "1" } },
      log: silent,
      opts: {},
    });

    const prompts = readFileSync(process.env.MOCK_ARGV_FILE, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as string[]))
      .map((argv) => argv[argv.indexOf("-p") + 1] ?? "");
    const secondJudge = prompts.find((p) => p.includes("web/app/settings/rest/desktop/dark"))!;
    expect(secondJudge).toContain("Also open elsewhere");
    expect(secondJudge).toContain("[contrast/body-text]");
    // And the first group could not have seen it: there was nothing yet.
    const firstJudge = prompts.find((p) => p.includes("web/app/home/rest/desktop/dark"))!;
    expect(firstJudge).not.toContain("Also open elsewhere");
  });

  test("a name the refuter killed is not offered to the next group", async () => {
    // The mock refuter confirms index 0 and refutes the rest, so a group whose
    // only finding is a sibling copy ends with nothing confirmed. Offering a
    // refuted name would invite the next group to file what was just killed.
    const r = project();
    const first = [shot("web/app/home/rest/desktop/dark"), shot("web/app/home/rest/phone/dark")];
    const second = [shot("web/app/settings/rest/desktop/dark")];
    const a = stubPanel("panel-a", ["contrast"]);
    const plan = planOf([a], [first, second]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_ARGV_FILE = join(evidenceDir(r), "argv.txt");
    process.env.MOCK_VERIFY = JSON.stringify({
      verdicts: [
        { index: 0, verdict: "refuted", note: "not visible" },
        { index: 1, verdict: "refuted", note: "not visible" },
      ],
    });

    const pass = await judgeInBatches({
      resolved: r,
      plan,
      shotsById: new Map([...first, ...second].map((s) => [s.id, s])),
      parsed: { positionals: [], flags: { concurrency: "1" } },
      log: silent,
      opts: {},
    });
    expect(pass.confirmed.filter((f) => f.shotId.includes("home"))).toHaveLength(0);

    const prompts = readFileSync(process.env.MOCK_ARGV_FILE, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as string[]))
      .map((argv) => argv[argv.indexOf("-p") + 1] ?? "");
    const secondJudge = prompts.find((p) => p.includes("web/app/settings/rest/desktop/dark"))!;
    expect(secondJudge).not.toContain("Also open elsewhere");
  });
});

describe("the lane rule", () => {
  test("a category another panel owns is rejected, and the incident names the filer", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"]);
    const plan = planOf([a], [[s]]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_JUDGE_CATEGORY = "spacing";

    const pass = await drive(r, plan, [s]);
    expect(pass.confirmed).toHaveLength(0);
    // The shot was accounted for by the reply (in findings), but the finding
    // was rejected, so the shot is NOT clean and the pair must not cache.
    expect(pass.rejected).toBeGreaterThan(0);
    const incidents = readFileSync(join(process.env.LOOKOUT_HOME!, "incidents.jsonl"), "utf8");
    expect(incidents).toContain("outside the panel-a panel's lane");
    expect(incidents).toContain('"judge":"panel-a"');
  });

  test("an in-lane finding is stamped with the owning specialist", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"]);
    const plan = planOf([a], [[s]]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";

    const pass = await drive(r, plan, [s]);
    // The stamp names the registry owner of the category, not the caller:
    // contrast belongs to judge-visibility however it was filed.
    expect(pass.confirmed[0]?.judge).toBe("judge-visibility");
  });
});

describe("pooled refutation", () => {
  test("one refuter call covers every panel's findings for the group", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"]);
    const b = stubPanel("panel-b", ["spacing"]);
    const plan = planOf([a, b], [[s]], {
      prior: [{ shotId: "*", category: "spacing", attribute: "row-gap", title: "gaps vary" }],
    });
    const argvFile = join(evidenceDir(r), "argv.jsonl");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_ARGV_FILE = argvFile;

    const pass = await drive(r, plan, [s]);
    const prompts = readFileSync(argvFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as string[])[1]!);
    const verifyPrompts = prompts.filter((p) => p.includes("adversarial verifier"));
    const judgePrompts = prompts.filter((p) => p.includes("## Category vocabulary"));
    expect(judgePrompts).toHaveLength(2);
    expect(verifyPrompts).toHaveLength(1);
    // Both panels' findings reached the one refuter call.
    expect(verifyPrompts[0]).toContain("contrast");
    expect(verifyPrompts[0]).toContain("spacing");
    // Priors travel per lane: the spacing prior reaches only the spacing panel.
    const withPrior = judgePrompts.filter((p) => p.includes("ALREADY FILED"));
    expect(withPrior).toHaveLength(1);
    expect(withPrior[0]).toContain("- spacing:");
    // The mock confirms index 0 and refutes the rest, so exactly one category
    // survives; the refuted one's panel records a clean verdict.
    expect(pass.confirmed).toHaveLength(1);
    expect(pass.refuted).toHaveLength(1);
    await recordOutcome({ resolved: r, scope: { shots: [s] } as CheckScope, plan, pass, log: silent });
    const back = await loadLedger(r);
    const confirmedCat = pass.confirmed[0]!.category;
    const confirmedPanel = confirmedCat === "contrast" ? a : b;
    const refutedPanel = confirmedCat === "contrast" ? b : a;
    expect(back.entries[ledgerKey(groupHash([s]), identityOf(confirmedPanel))]?.verdict).toBe("findings");
    expect(back.entries[ledgerKey(groupHash([s]), identityOf(refutedPanel))]?.verdict).toBe("clean");
  });
});

describe("the plan partition", () => {
  test("a group is clean only when every panel ruled; a missing panel is one work item", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"]);
    const b = stubPanel("panel-b", ["spacing"]);
    // Panel a's verdict is on record; panel b has never judged this group.
    const ledger = await loadLedger(r);
    ledger.entries[ledgerKey(groupHash([s]), identityOf(a))] = {
      verdict: "findings",
      findings: [
        { shotId: s.id, category: "contrast", attribute: "x", severity: "high",
          title: "t", problem: "p", expected: "e", observed: "o", verified: true } as VerifiedFinding,
      ],
      panel: "panel-a",
      shotIds: [s.id],
      judgedAt: "t",
      runId: "old",
    };
    await saveLedger(r, ledger);

    const plan = await planJudging(r, [s], { positionals: [], flags: {} }, [a, b]);
    expect(plan.toJudge).toHaveLength(1);
    expect(plan.toJudge[0]?.panel.def.name).toBe("panel-b");
    expect(plan.cached).toBe(0);
    expect(plan.toJudgeShots).toHaveLength(1);
    // The served panel's findings still arrive, marked cached.
    expect(plan.cachedFindings.map((f) => f.category)).toEqual(["contrast"]);
  });

  test("--panels narrows who judges, keeps whose verdicts are cached, and rejects a stranger", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"]);
    const b = stubPanel("panel-b", ["spacing"]);
    const ledger = await loadLedger(r);
    ledger.entries[ledgerKey(groupHash([s]), identityOf(a))] = {
      verdict: "findings",
      findings: [
        { shotId: s.id, category: "contrast", attribute: "x", severity: "high",
          title: "t", problem: "p", expected: "e", observed: "o", verified: true } as VerifiedFinding,
      ],
      panel: "panel-a",
      shotIds: [s.id],
      judgedAt: "t",
      runId: "old",
    };
    await saveLedger(r, ledger);

    // Only panel-b judges, but panel-a's standing verdict is still served.
    const plan = await planJudging(r, [s], { positionals: [], flags: { panels: "panel-b" } }, [a, b]);
    expect(plan.panels.map((p) => p.def.name)).toEqual(["panel-b"]);
    expect(plan.toJudge.map((w) => w.panel.def.name)).toEqual(["panel-b"]);
    expect(plan.cachedFindings.map((f) => f.category)).toEqual(["contrast"]);

    // A filtered-out MISS is out of scope, not unjudged: drop panel-a's entry
    // and the plan still owes only panel-b's call.
    delete ledger.entries[ledgerKey(groupHash([s]), identityOf(a))];
    await saveLedger(r, ledger);
    const scoped = await planJudging(r, [s], { positionals: [], flags: { panels: "panel-b" } }, [a, b]);
    expect(scoped.toJudge.map((w) => w.panel.def.name)).toEqual(["panel-b"]);

    await expect(
      planJudging(r, [s], { positionals: [], flags: { panels: "nope" } }, [a, b]),
    ).rejects.toThrow(LookoutError);
  });
});

describe("the shipped registry, end to end", () => {
  test("a plain group owes five calls, a design-bearing one six", async () => {
    const r = project();
    const plain = shot("web/app/home/rest/desktop/light");
    const plan = await planJudging(r, [plain], { positionals: [], flags: {} });
    expect(plan.toJudge.map((w) => w.panel.def.name).sort()).toEqual([
      "judge-craft",
      "judge-geometry",
      "judge-integrity",
      "judge-text",
      "judge-visibility",
    ]);
    const design = { ...shot("web/app/hero/rest/desktop/light"), design: "/m.png" };
    const plan2 = await planJudging(r, [design], { positionals: [], flags: {} });
    expect(plan2.toJudge).toHaveLength(6);
    expect(plan2.toJudge.map((w) => w.panel.def.name)).toContain("judge-design-parity");
  });

  test("amending one panel re-judges only that panel", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const judges = await loadJudges(r);
    const ledger = await loadLedger(r);
    for (const j of judges.filter((x) => !x.def.designOnly)) {
      ledger.entries[ledgerKey(groupHash([s]), identityOf(j))] = {
        verdict: "clean",
        panel: j.def.name,
        shotIds: [s.id],
        judgedAt: "t",
        runId: "old",
      };
    }
    await saveLedger(r, ledger);
    const before = await planJudging(r, [s], { positionals: [], flags: {} });
    expect(before.toJudge).toHaveLength(0);
    expect(before.cached).toBe(1);

    // A learned amendment to one specialist moves only its prompt hash.
    const dir = join(r.projectDir, ".lookout", "skills", "judge-craft");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: judge-craft\nversion: 2\n---\n\n- The hero is deliberately loud.\n",
    );
    const after = await planJudging(r, [s], { positionals: [], flags: {} });
    expect(after.toJudge.map((w) => w.panel.def.name)).toEqual(["judge-craft"]);
  });
});

describe("repairs stay in their lane", () => {
  test("repairing one panel's entry never evicts the sibling's cached findings", async () => {
    const r = project();
    const s = shot("web/app/home/rest/desktop/light");
    const a = stubPanel("panel-a", ["contrast"]);
    const b = stubPanel("panel-b", ["spacing"]);
    const unverified = {
      shotId: s.id, category: "contrast", attribute: "x", severity: "high",
      title: "t", problem: "p", expected: "e", observed: "o", verified: false,
    } as VerifiedFinding;
    const standing = {
      shotId: s.id, category: "spacing", attribute: "y", severity: "medium",
      title: "t2", problem: "p", expected: "e", observed: "o", verified: true,
    } as VerifiedFinding;
    const ledger = await loadLedger(r);
    const keyA = ledgerKey(groupHash([s]), identityOf(a));
    const keyB = ledgerKey(groupHash([s]), identityOf(b));
    ledger.entries[keyA] = {
      verdict: "findings", findings: [unverified], panel: "panel-a",
      shotIds: [s.id], judgedAt: "t", runId: "old",
    };
    ledger.entries[keyB] = {
      verdict: "findings", findings: [standing], panel: "panel-b",
      shotIds: [s.id], judgedAt: "t", runId: "old",
    };
    const plan = planOf([a, b], [], {
      ledger,
      cachedFindings: [
        { ...unverified, cached: true },
        { ...standing, cached: true },
      ],
      cached: 1,
    });
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";

    const res = await reverifyCached({
      resolved: r,
      plan,
      shotsById: new Map([[s.id, s]]),
      parsed: { positionals: [], flags: {} },
      log: silent,
    });
    // Only panel-a held unverified findings, so only it is repaired.
    expect(res.repaired).toBe(1);
    expect(plan.ledger.entries[keyA]?.findings?.[0]?.verified).toBe(true);
    // The sibling's cached finding survives the splice untouched.
    const spacing = plan.cachedFindings.find((f) => f.category === "spacing");
    expect(spacing?.verified).toBe(true);
    expect(plan.ledger.entries[keyB]?.findings?.[0]).toEqual(standing);
  });
});
