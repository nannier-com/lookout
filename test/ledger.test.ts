// The judge ledger's identity: what re-judges a view group, what leaves its
// cached verdict standing, and the round trip through disk. The design-PNG
// and handoff terms exist because both are judge inputs that previously
// changed no key: swapping a hand-off image or editing handoff.md left every
// cached design-parity verdict standing.
import { describe, expect, test } from "bun:test";
import {
  groupHash,
  panelIdentity,
  ledgerKey,
  loadLedger,
  recordVerdicts,
  saveLedger,
} from "../src/judge/ledger.js";
import { sha256 } from "../src/util.js";
import { tmpProject } from "./tmp-project.js";
import type { ShotRecord } from "../src/types.js";

function shot(over: Partial<ShotRecord> = {}): ShotRecord {
  return {
    id: "web/app/home/rest/desktop/light",
    target: "app",
    route: "/",
    routeName: "home",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "light",
    path: "web/app/home/rest/desktop/light.png",
    hash: "abc123",
    bytes: 10,
    width: 100,
    height: 100,
    animated: false,
    capturedAt: "2026-01-01T00:00:00.000Z",
    runId: "r1",
    deterministicFindings: [],
    ...over,
  };
}

describe("group hash", () => {
  test("a design-free group hashes exactly as it always has", () => {
    const a = shot();
    const b = shot({ id: "web/app/home/rest/desktop/dark", scheme: "dark", hash: "def456" });
    // The legacy format, spelled out: adding the design term must not
    // invalidate every existing ledger on projects with no hand-offs.
    const legacy = sha256(
      new TextEncoder().encode(
        [`${a.id}@${a.hash}`, `${b.id}@${b.hash}`].sort().join("\n"),
      ),
    );
    expect(groupHash([a, b])).toBe(legacy);
  });

  test("a swapped design image changes the group hash; same design does not", () => {
    const base = [shot({ design: "/designs/home.png", designHash: "d1" })];
    const same = [shot({ design: "/designs/home.png", designHash: "d1" })];
    const swapped = [shot({ design: "/designs/home.png", designHash: "d2" })];
    expect(groupHash(same)).toBe(groupHash(base));
    expect(groupHash(swapped)).not.toBe(groupHash(base));
    expect(groupHash([shot()])).not.toBe(groupHash(base));
  });

  test("member order never perturbs the hash", () => {
    const a = shot({ designHash: "d1" });
    const b = shot({ id: "web/app/home/rest/phone/light", formFactor: "phone", hash: "x" });
    expect(groupHash([a, b])).toBe(groupHash([b, a]));
  });
});

describe("panel identity", () => {
  const base = {
    panel: "all",
    version: 4,
    panelText: "rubric",
    refuteText: "refute",
    handoffText: "handoff",
    model: "sonnet",
  };

  test("two panels of one group hold separate keys over the same hash", () => {
    const a = panelIdentity(base);
    const b = panelIdentity({ ...base, panel: "judge-craft" });
    expect(ledgerKey("abc", a)).not.toBe(ledgerKey("abc", b));
    expect(ledgerKey("abc", a).startsWith("abc@")).toBe(true);
    expect(ledgerKey("abc", b).startsWith("abc@")).toBe(true);
  });

  test("editing handoff.md re-judges what it could have changed", () => {
    const a = panelIdentity(base);
    const b = panelIdentity({ ...base, handoffText: "handoff, edited" });
    expect(a.promptHash).not.toBe(b.promptHash);
    expect(panelIdentity({ ...base }).promptHash).toBe(a.promptHash);
  });

  test("no two texts can slide across a boundary and hash the same", () => {
    const a = panelIdentity({ ...base, panelText: "ab", refuteText: "c" });
    const b = panelIdentity({ ...base, panelText: "a", refuteText: "bc" });
    expect(a.promptHash).not.toBe(b.promptHash);
  });
});

describe("the ledger round trip", () => {
  test("a recorded verdict is served back under the same key, and only that key", async () => {
    const r = tmpProject("lookout-ledger-");
    const id = panelIdentity({
      panel: "all",
      version: 4,
      panelText: "rubric",
      refuteText: "refute",
      handoffText: "",
      model: "sonnet",
    });
    const group = [shot()];
    const ledger = await loadLedger(r);
    recordVerdicts(ledger, "run1", id, [
      { shots: group, findings: [] },
    ]);
    await saveLedger(r, ledger);

    const back = await loadLedger(r);
    const entry = back.entries[ledgerKey(groupHash(group), id)];
    expect(entry?.verdict).toBe("clean");
    // A different identity is a different key: nothing is served across it.
    const other = panelIdentity({
      panel: "all",
      version: 4,
      panelText: "rubric",
      refuteText: "refute",
      handoffText: "changed",
      model: "sonnet",
    });
    expect(back.entries[ledgerKey(groupHash(group), other)]).toBeUndefined();
  });
});

describe("pruning unreachable entries", () => {
  test("a dead hash is dropped; every identity of a live hash is kept", async () => {
    const { pruneLedger } = await import("../src/judge/ledger.js");
    const live = shot();
    const id1 = panelIdentity({ panel: "all", version: 4, panelText: "R", refuteText: "F", handoffText: "", model: "sonnet" });
    const id2 = panelIdentity({ panel: "all", version: 4, panelText: "R", refuteText: "F", handoffText: "", model: "opus" });
    const ledger = { note: "", entries: {} as Record<string, never> } as never as import("../src/judge/ledger.js").Ledger;
    const entry = { verdict: "clean" as const, panel: "all", shotIds: [live.id], judgedAt: "t", runId: "r" };
    ledger.entries[ledgerKey(groupHash([live]), id1)] = entry;
    ledger.entries[ledgerKey(groupHash([live]), id2)] = entry;
    ledger.entries[ledgerKey("deadbeef", id1)] = entry;

    const dropped = pruneLedger(ledger, new Set([groupHash([live])]));
    expect(dropped).toBe(1);
    expect(Object.keys(ledger.entries)).toHaveLength(2);
    expect(ledger.entries[ledgerKey("deadbeef", id1)]).toBeUndefined();
  });

  test("a pre-panel key is dropped even when its hash is still live", async () => {
    const { pruneLedger, loadLedger } = await import("../src/judge/ledger.js");
    const live = shot();
    const id = panelIdentity({ panel: "all", version: 4, panelText: "R", refuteText: "F", handoffText: "", model: "sonnet" });
    const ledger = await loadLedger(tmpProject("lookout-ledger-legacy-"));
    const entry = { verdict: "clean" as const, panel: "all", shotIds: [live.id], judgedAt: "t", runId: "r" };
    ledger.entries[ledgerKey(groupHash([live]), id)] = entry;
    // The four-segment format the panel term replaced. Nothing computes this
    // key any more, so keeping it would grow the committed file forever.
    ledger.entries[`${groupHash([live])}@v4@${id.promptHash}@sonnet`] = entry;

    const dropped = pruneLedger(ledger, new Set([groupHash([live])]));
    expect(dropped).toBe(1);
    expect(ledger.entries[ledgerKey(groupHash([live]), id)]).toBeDefined();
  });
});

describe("the cache partition serves animated groups", () => {
  test("an animated group with matching entries is served, not re-judged forever", async () => {
    const { planJudging } = await import("../src/check/plan.js");
    const { loadJudges } = await import("../src/judge/rubric.js");
    const { loadSkill } = await import("../src/skills/load.js");
    const r = tmpProject("lookout-plan-animated-");
    const judges = await loadJudges(r);
    const refute = await loadSkill(r, "refute-finding");
    const moving = shot({ animated: true });
    const ledger = await loadLedger(r);
    // Every panel that would judge a designless group holds a verdict.
    for (const j of judges.filter((x) => !x.def.designOnly)) {
      const id = panelIdentity({
        panel: j.def.name,
        version: j.version,
        panelText: j.text,
        refuteText: refute.text,
        handoffText: j.handoff,
        model: "sonnet",
      });
      ledger.entries[ledgerKey(groupHash([moving]), id)] = {
        verdict: "clean",
        panel: j.def.name,
        shotIds: [moving.id],
        judgedAt: "t",
        runId: "old",
      };
    }
    await saveLedger(r, ledger);

    const plan = await planJudging(r, [moving], { positionals: [], flags: {} });
    expect(plan.cached).toBe(1);
    expect(plan.toJudge).toHaveLength(0);
  });
});

describe("--no-cache", () => {
  test("reads nothing and re-judges, without discarding the rest of the ledger", async () => {
    const { planJudging } = await import("../src/check/plan.js");
    const { loadJudges } = await import("../src/judge/rubric.js");
    const { loadSkill } = await import("../src/skills/load.js");
    const r = tmpProject("lookout-plan-nocache-");
    const judges = await loadJudges(r);
    const refute = await loadSkill(r, "refute-finding");
    const first = judges[0]!;
    const id = panelIdentity({
      panel: first.def.name,
      version: first.version,
      panelText: first.text,
      refuteText: refute.text,
      handoffText: first.handoff,
      model: "sonnet",
    });
    const s = shot();
    const ledger = await loadLedger(r);
    ledger.entries[ledgerKey(groupHash([s]), id)] = {
      verdict: "clean", panel: first.def.name, shotIds: [s.id], judgedAt: "t", runId: "old",
    };
    ledger.entries[ledgerKey("otherhash", id)] = {
      verdict: "clean", panel: first.def.name, shotIds: ["x"], judgedAt: "t", runId: "old",
    };
    await saveLedger(r, ledger);

    const plan = await planJudging(r, [s], { positionals: [], flags: { "no-cache": true } });
    expect(plan.cached).toBe(0);
    // Every panel a designless group answers to owes a call: nothing served.
    expect(plan.toJudge).toHaveLength(judges.filter((x) => !x.def.designOnly).length);
    // The unrelated entry survives in the object a later save writes back.
    expect(plan.ledger.entries[ledgerKey("otherhash", id)]).toBeDefined();
  });
});
