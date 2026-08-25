// Judge machinery tests: JSON extraction, batching, vocabulary enforcement,
// ledger keys, and a full engine round-trip through the mock claude binary.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { batchShots, extractJson, judgeBatch } from "../src/judge/engine.js";
import { ledgerKey } from "../src/judge/ledger.js";
import type { ShotRecord } from "../src/types.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

function shot(id: string, over: Partial<ShotRecord> = {}): ShotRecord {
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
    ...over,
  };
}

describe("extractJson", () => {
  test("reads a fenced block, the last when several, and bare objects", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('noise {"a":3} trailing')).toEqual({ a: 3 });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("batchShots", () => {
  test("keeps a route together, packs small groups, splits huge ones", () => {
    const shots = [
      ...["a", "b", "c"].flatMap((r) =>
        ["desktop", "phone"].map((ff) => shot(`web/app/${r}/rest/${ff}/dark`)),
      ),
      ...Array.from({ length: 12 }, (_, i) => shot(`web/app/big/rest/desktop/dark`, { id: `web/app/big/s${i}/desktop/dark` })),
    ];
    const batches = batchShots(shots, 6);
    // Every batch respects the cap.
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(6);
    // Routes a+b+c (2 shots each) pack into one batch of 6.
    expect(batches[0]!.length).toBe(6);
    // Nothing lost.
    expect(batches.flat().length).toBe(shots.length);
  });
});

describe("judgeBatch through the mock binary", () => {
  test("accepts vocabulary findings, rejects unknown categories, keeps cost", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    const shots = [shot("web/app/x/rest/desktop/dark"), shot("web/app/x/rest/phone/dark")];
    const res = await judgeBatch("RUBRIC", "proj", shots, "/tmp", "sonnet");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.category).toBe("contrast");
    expect(res.rejected.length).toBe(1);
    expect(res.rejected[0]!.reason).toContain("not-a-category");
    expect(res.cleanShotIds).toEqual(["web/app/x/rest/phone/dark"]);
    expect(res.costUsd).toBeCloseTo(0.0123);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("copes with prose around the fenced block", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "prose";
    const shots = [shot("web/app/y/rest/desktop/dark")];
    const res = await judgeBatch("RUBRIC", "proj", shots, "/tmp", "sonnet");
    expect(res.findings.length).toBe(0);
    expect(res.cleanShotIds).toEqual(["web/app/y/rest/desktop/dark"]);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });
});

describe("ledger", () => {
  test("key includes hash, rubric version, and model", () => {
    expect(ledgerKey("abc", 3, "sonnet")).toBe("abc@r3@sonnet");
  });
});
