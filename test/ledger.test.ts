// The judge ledger's identity: what re-judges a view group, what leaves its
// cached verdict standing, and the round trip through disk. The design-PNG
// and handoff terms exist because both are judge inputs that previously
// changed no key: swapping a hand-off image or editing handoff.md left every
// cached design-parity verdict standing.
import { describe, expect, test } from "bun:test";
import {
  groupHash,
  judgeIdentity,
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

describe("judge identity", () => {
  const base = { version: 4, rubricText: "rubric", refuteText: "refute", handoffText: "handoff", model: "sonnet" };

  test("editing handoff.md re-judges what it could have changed", () => {
    const a = judgeIdentity(base);
    const b = judgeIdentity({ ...base, handoffText: "handoff, edited" });
    expect(a.promptHash).not.toBe(b.promptHash);
    expect(judgeIdentity({ ...base }).promptHash).toBe(a.promptHash);
  });

  test("no two texts can slide across a boundary and hash the same", () => {
    const a = judgeIdentity({ ...base, rubricText: "ab", refuteText: "c" });
    const b = judgeIdentity({ ...base, rubricText: "a", refuteText: "bc" });
    expect(a.promptHash).not.toBe(b.promptHash);
  });
});

describe("the ledger round trip", () => {
  test("a recorded verdict is served back under the same key, and only that key", async () => {
    const r = tmpProject("lookout-ledger-");
    const id = judgeIdentity({
      version: 4,
      rubricText: "rubric",
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
    const other = judgeIdentity({
      version: 4,
      rubricText: "rubric",
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
    const id1 = judgeIdentity({ version: 4, rubricText: "R", refuteText: "F", handoffText: "", model: "sonnet" });
    const id2 = judgeIdentity({ version: 4, rubricText: "R", refuteText: "F", handoffText: "", model: "opus" });
    const ledger = { note: "", entries: {} as Record<string, never> } as never as import("../src/judge/ledger.js").Ledger;
    const entry = { verdict: "clean" as const, shotIds: [live.id], judgedAt: "t", runId: "r" };
    ledger.entries[ledgerKey(groupHash([live]), id1)] = entry;
    ledger.entries[ledgerKey(groupHash([live]), id2)] = entry;
    ledger.entries[ledgerKey("deadbeef", id1)] = entry;

    const dropped = pruneLedger(ledger, new Set([groupHash([live])]));
    expect(dropped).toBe(1);
    expect(Object.keys(ledger.entries)).toHaveLength(2);
    expect(ledger.entries[ledgerKey("deadbeef", id1)]).toBeUndefined();
  });
});

describe("the cache partition serves animated groups", () => {
  test("an animated group with a matching entry is served, not re-judged forever", async () => {
    const { planJudging } = await import("../src/check/plan.js");
    const { loadRubric } = await import("../src/judge/rubric.js");
    const { loadSkill } = await import("../src/skills/load.js");
    const r = tmpProject("lookout-plan-animated-");
    const rubric = await loadRubric(r);
    const refute = await loadSkill(r, "refute-finding");
    const id = judgeIdentity({
      version: rubric.version,
      rubricText: rubric.text,
      refuteText: refute.text,
      handoffText: rubric.handoff,
      model: "sonnet",
    });
    const moving = shot({ animated: true });
    const ledger = await loadLedger(r);
    ledger.entries[ledgerKey(groupHash([moving]), id)] = {
      verdict: "clean",
      shotIds: [moving.id],
      judgedAt: "t",
      runId: "old",
    };
    await saveLedger(r, ledger);

    const plan = await planJudging(r, [moving], { positionals: [], flags: {} });
    expect(plan.cached).toBe(1);
    expect(plan.toJudge).toHaveLength(0);
  });
});
