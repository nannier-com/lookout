// Refute-on-read: a cached group whose findings the refuter never saw gets
// the adversarial pass on a later run, and the ledger entry is repaired in
// place. Before this existed, a --no-verify run's findings were served
// verbatim forever while a refuter crash re-bought the whole judge pass.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { reverifyCached, MAX_REVERIFY_GROUPS } from "../src/check/reverify.js";
import { groupHash, panelIdentity, ledgerKey, type Ledger } from "../src/judge/ledger.js";
import { loadSkill } from "../src/skills/load.js";
import { evidenceDir } from "../src/config.js";
import { viewGroupId } from "../src/judge/grouping.js";
import { CATEGORIES, type PanelRubric } from "../src/judge/rubric.js";
import { tmpProject } from "./tmp-project.js";
import type { JudgePlan } from "../src/check/plan.js";
import type { VerifiedFinding } from "../src/judge/verify.js";
import type { ShotRecord } from "../src/types.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");
const refute = await loadSkill(tmpProject("lookout-reverify-"), "refute-finding");

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

function finding(shotId: string, over: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    shotId,
    category: "contrast",
    attribute: "low-contrast",
    severity: "high",
    title: "t",
    problem: "p",
    expected: "e",
    observed: "o",
    verified: false,
    ...over,
  } as VerifiedFinding;
}

/** A plan whose ledger holds one entry per given group, all cache-served. */
function planWith(groups: { shots: ShotRecord[]; findings: VerifiedFinding[] }[]): {
  plan: JudgePlan;
  shotsById: Map<string, ShotRecord>;
  keys: string[];
} {
  const allPanel: PanelRubric = {
    def: { name: "all", categories: CATEGORIES },
    text: "R",
    version: 4,
    handoff: "",
  };
  const identity = panelIdentity({
    panel: "all",
    version: 4,
    panelText: "R",
    refuteText: refute.text,
    handoffText: "",
    model: "sonnet",
  });
  const ledger: Ledger = { note: "", entries: {} };
  const shotsById = new Map<string, ShotRecord>();
  const cachedFindings: (VerifiedFinding & { cached: boolean })[] = [];
  const keys: string[] = [];
  for (const g of groups) {
    const key = ledgerKey(groupHash(g.shots), identity);
    keys.push(key);
    ledger.entries[key] = {
      verdict: g.findings.length === 0 ? "clean" : "findings",
      ...(g.findings.length > 0 ? { findings: g.findings } : {}),
      panel: "all",
      shotIds: g.shots.map((s) => s.id).sort(),
      judgedAt: "2026-08-25T00:00:00Z",
      runId: "old",
    };
    for (const s of g.shots) shotsById.set(s.id, s);
    cachedFindings.push(...g.findings.map((f) => ({ ...f, cached: true })));
  }
  const plan = {
    panels: [allPanel],
    refute,
    model: "sonnet",
    ledger,
    identities: new Map([["all", identity]]),
    toJudge: [],
    toJudgeShots: [],
    cachedFindings,
    cached: shotsById.size,
    prior: [],
  } as unknown as JudgePlan;
  return { plan, shotsById, keys };
}

const silent = (): void => {};

describe("refute-on-read", () => {
  test("a confirmed cached finding is repaired to verified, in the ledger and the outcome", async () => {
    const r = tmpProject("lookout-rev-confirm-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const s = shot("web/app/home/rest/desktop/light");
    const { plan, shotsById, keys } = planWith([{ shots: [s], findings: [finding(s.id)] }]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    try {
      const res = await reverifyCached({ resolved: r, plan, shotsById, parsed: { positionals: [], flags: {} }, log: silent });
      expect(res.repaired).toBe(1);
      expect(plan.ledger.entries[keys[0]!]?.findings?.[0]?.verified).toBe(true);
      expect(plan.cachedFindings[0]?.verified).toBe(true);
      expect(plan.cachedFindings[0]?.cached).toBe(true);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
      delete process.env.MOCK_MODE;
    }
  });

  test("a refuted cached finding leaves both the ledger and the outcome", async () => {
    const r = tmpProject("lookout-rev-refute-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const s = shot("web/app/home/rest/desktop/light");
    // verify mode confirms index 0 and refutes the rest, so the second
    // finding of this entry is the one that dies.
    const { plan, shotsById, keys } = planWith([
      { shots: [s], findings: [finding(s.id), finding(s.id, { attribute: "second", title: "t2" })] },
    ]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    try {
      const res = await reverifyCached({ resolved: r, plan, shotsById, parsed: { positionals: [], flags: {} }, log: silent });
      expect(res.refuted).toHaveLength(1);
      expect(plan.ledger.entries[keys[0]!]?.findings).toHaveLength(1);
      expect(plan.cachedFindings).toHaveLength(1);
      expect(plan.cachedFindings[0]?.verified).toBe(true);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
      delete process.env.MOCK_MODE;
    }
  });

  test("kept verified findings survive a repair that kills the unverified one", async () => {
    const r = tmpProject("lookout-rev-kept-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const a = shot("web/app/one/rest/desktop/light");
    const { plan, shotsById, keys } = planWith([
      { shots: [a], findings: [finding(a.id, { verified: true }), finding(a.id, { attribute: "dies" })] },
    ]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_VERIFY = JSON.stringify({ verdicts: [{ index: 0, verdict: "refuted", note: "nope" }] });
    try {
      await reverifyCached({ resolved: r, plan, shotsById, parsed: { positionals: [], flags: {} }, log: silent });
      const entry = plan.ledger.entries[keys[0]!]!;
      expect(entry.findings).toHaveLength(1);
      expect(entry.findings?.[0]?.verified).toBe(true);
      expect(entry.verdict).toBe("findings");
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
      delete process.env.MOCK_VERIFY;
    }
  });

  test("an entry refuted down to nothing becomes a clean verdict", async () => {
    const r = tmpProject("lookout-rev-clean-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const a = shot("web/app/one/rest/desktop/light");
    const { plan, shotsById, keys } = planWith([{ shots: [a], findings: [finding(a.id)] }]);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_VERIFY = JSON.stringify({ verdicts: [{ index: 0, verdict: "refuted", note: "nope" }] });
    try {
      await reverifyCached({ resolved: r, plan, shotsById, parsed: { positionals: [], flags: {} }, log: silent });
      const entry = plan.ledger.entries[keys[0]!]!;
      expect(entry.verdict).toBe("clean");
      expect(entry.findings).toBeUndefined();
      expect(plan.cachedFindings).toHaveLength(0);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
      delete process.env.MOCK_VERIFY;
    }
  });

  test("a repair that fails leaves the entry exactly as it was", async () => {
    const r = tmpProject("lookout-rev-fail-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const s = shot("web/app/home/rest/desktop/light");
    const { plan, shotsById, keys } = planWith([{ shots: [s], findings: [finding(s.id)] }]);
    const before = JSON.stringify(plan.ledger.entries[keys[0]!]);
    process.env.LOOKOUT_CLAUDE_BIN = join(import.meta.dir, "no-such-claude-binary");
    try {
      const res = await reverifyCached({ resolved: r, plan, shotsById, parsed: { positionals: [], flags: {} }, log: silent });
      expect(res.repaired).toBe(0);
      expect(JSON.stringify(plan.ledger.entries[keys[0]!])).toBe(before);
      expect(plan.cachedFindings[0]?.verified).toBe(false);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });

  test("--no-verify skips the pass entirely", async () => {
    const r = tmpProject("lookout-rev-skip-");
    const s = shot("web/app/home/rest/desktop/light");
    const { plan, shotsById } = planWith([{ shots: [s], findings: [finding(s.id)] }]);
    process.env.LOOKOUT_CLAUDE_BIN = join(import.meta.dir, "no-such-claude-binary");
    try {
      const res = await reverifyCached({
        resolved: r,
        plan,
        shotsById,
        parsed: { positionals: [], flags: { "no-verify": true } },
        log: silent,
      });
      expect(res.repaired).toBe(0);
      expect(res.costUsd).toBe(0);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });

  test("the cap holds: the ninth group waits for the next run", async () => {
    const r = tmpProject("lookout-rev-cap-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const groups = Array.from({ length: MAX_REVERIFY_GROUPS + 1 }, (_, i) => {
      const s = shot(`web/app/route${i}/rest/desktop/light`);
      return { shots: [s], findings: [finding(s.id)] };
    });
    const { plan, shotsById } = planWith(groups);
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    try {
      const res = await reverifyCached({ resolved: r, plan, shotsById, parsed: { positionals: [], flags: {} }, log: silent });
      expect(res.repaired).toBe(MAX_REVERIFY_GROUPS);
      expect(res.deferred).toBe(1);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
      delete process.env.MOCK_MODE;
    }
  });

  // A screen walk spreads one run's cap over many calls, one per screen, so
  // the caller says how much of the cap is left. Zero means "spend nothing":
  // the debt is reported as deferred and no refuter is called.
  test("a caller's limit is the cap for that call, and zero spends nothing", async () => {
    const r = tmpProject("lookout-rev-limit-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const groups = Array.from({ length: 3 }, (_, i) => {
      const s = shot(`web/app/route${i}/rest/desktop/light`);
      return { shots: [s], findings: [finding(s.id)] };
    });
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "verify";
    try {
      const two = planWith(groups);
      const res = await reverifyCached({
        resolved: r,
        plan: two.plan,
        shotsById: two.shotsById,
        parsed: { positionals: [], flags: {} },
        log: silent,
        limit: 2,
      });
      expect(res.repaired).toBe(2);
      expect(res.deferred).toBe(1);

      const none = planWith(groups);
      const spent = await reverifyCached({
        resolved: r,
        plan: none.plan,
        shotsById: none.shotsById,
        parsed: { positionals: [], flags: {} },
        log: silent,
        limit: 0,
      });
      expect(spent.repaired).toBe(0);
      expect(spent.deferred).toBe(3);
      expect(spent.costUsd).toBe(0);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
      delete process.env.MOCK_MODE;
    }
  });
});

// The flip that feeds refute-on-read: a refuter subprocess failure no longer
// throws the judge's work out of the cache. The group caches with its
// findings unverified, and the repair pass above is the road back.
describe("refuter failure caches the judged group", () => {
  test("the batch's shots are not marked uncacheable when only the refuter fails", async () => {
    const { judgeInBatches } = await import("../src/check/batches.js");
    const r = tmpProject("lookout-flip-");
    mkdirSync(evidenceDir(r), { recursive: true });
    const s = shot("web/app/home/rest/desktop/light");
    const allPanel: PanelRubric = {
      def: { name: "all", categories: CATEGORIES },
      text: "judge\n{{manifest}}",
      version: 4,
      handoff: "",
    };
    const identity = panelIdentity({
      panel: "all",
      version: 4,
      panelText: "judge",
      refuteText: refute.text,
      handoffText: "",
      model: "sonnet",
    });
    const plan = {
      panels: [allPanel],
      refute,
      model: "sonnet",
      ledger: { note: "", entries: {} },
      identities: new Map([["all", identity]]),
      toJudge: [{ panel: allPanel, identity, groupId: viewGroupId(s), shots: [s] }],
      toJudgeShots: [s],
      cachedFindings: [],
      cached: 0,
      prior: [],
    } as unknown as JudgePlan;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_VERIFY_FAIL = "1";
    try {
      const pass = await judgeInBatches({
        resolved: r,
        plan,
        shotsById: new Map([[s.id, s]]),
        parsed: { positionals: [], flags: {} },
        log: silent,
        opts: {},
      });
      expect(pass.confirmed.length).toBeGreaterThan(0);
      expect(pass.confirmed[0]?.verified).toBe(false);
      expect(pass.uncacheable.size).toBe(0);
      expect(pass.failedBatches).toHaveLength(0);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
      delete process.env.MOCK_VERIFY_FAIL;
    }
  });
});
