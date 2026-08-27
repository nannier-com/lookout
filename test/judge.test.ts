// Judge machinery tests: JSON extraction, batching, vocabulary enforcement,
// ledger keys, and a full engine round-trip through the mock claude binary.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { batchShots, extractJson, groupShots, judgeBatch, viewGroupId } from "../src/judge/engine.js";
import { groupHash, ledgerKey } from "../src/judge/ledger.js";
import { loadRubric } from "../src/judge/rubric.js";
import { tmpProject } from "./tmp-project.js";
import type { ShotRecord } from "../src/types.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

// The real composed prompt: the mock reads the manifest out of it.
const rubric = await loadRubric(tmpProject("lookout-judge-"));

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

describe("view groups", () => {
  test("a view is its schemes and form factors together", () => {
    const pair = ["dark", "light"].flatMap((sc) =>
      ["desktop", "phone"].map((ff) => shot(`web/app/login/rest/${ff}/${sc}`)),
    );
    const groups = groupShots(pair);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]!.length).toBe(4);
    expect(viewGroupId(pair[0]!)).toBe("app|web|/login|rest");
  });

  test("different routes and states are different views", () => {
    const groups = groupShots([
      shot("web/app/login/rest/desktop/dark"),
      shot("web/app/login/menu-open/desktop/dark"),
      shot("web/app/home/rest/desktop/dark"),
    ]);
    expect(groups.size).toBe(3);
  });
});

describe("batchShots", () => {
  test("packs small groups and never straddles a view across batches", () => {
    const shots = ["a", "b", "c"].flatMap((r) =>
      ["desktop", "phone"].map((ff) => shot(`web/app/${r}/rest/${ff}/dark`)),
    );
    const batches = batchShots(shots, 6);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(6);
    expect(batches[0]!.length).toBe(6);
    expect(batches.flat().length).toBe(shots.length);
    // No view id appears in two batches.
    const seen = new Map<string, number>();
    batches.forEach((b, i) => {
      for (const id of new Set(b.map(viewGroupId))) {
        expect(seen.has(id) ? seen.get(id) : i).toBe(i);
        seen.set(id, i);
      }
    });
  });

  test("an oversized view ships alone and whole rather than being split", () => {
    const big = Array.from({ length: 9 }, (_, i) =>
      shot(`web/app/big/rest/desktop/dark`, { id: `web/app/big/rest/ff${i}/dark` }),
    );
    const batches = batchShots([shot("web/app/small/rest/desktop/dark"), ...big], 6);
    const bigBatch = batches.find((b) => b.length === 9);
    expect(bigBatch).toBeDefined();
    expect(new Set(bigBatch!.map(viewGroupId)).size).toBe(1);
    expect(batches.flat().length).toBe(10);
  });
});

describe("judgeBatch through the mock binary", () => {
  test("accepts vocabulary findings, rejects unknown categories, keeps cost", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    const shots = [shot("web/app/x/rest/desktop/dark"), shot("web/app/x/rest/phone/dark")];
    const res = await judgeBatch(rubric.text, "proj", shots, "/tmp", "sonnet");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.category).toBe("contrast");
    // Every finding says what would prove it gone; the issue is built from these.
    expect(res.findings[0]!.acceptance).toEqual([
      "Body text is legible against the card background.",
    ]);
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
    const res = await judgeBatch(rubric.text, "proj", shots, "/tmp", "sonnet");
    expect(res.findings.length).toBe(0);
    expect(res.cleanShotIds).toEqual(["web/app/y/rest/desktop/dark"]);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });
});

describe("ledger", () => {
  test("key includes hash, judge skill version, and model", () => {
    expect(ledgerKey("abc", 3, "sonnet")).toBe("abc@v3@sonnet");
  });

  test("group hash is order-independent", () => {
    const a = shot("web/app/login/rest/desktop/dark");
    const b = shot("web/app/login/rest/desktop/light");
    expect(groupHash([a, b])).toBe(groupHash([b, a]));
  });

  test("one member changing invalidates the whole view", () => {
    // The regression this keying exists for: fixing the light shot must send
    // its unchanged dark partner back to the judge too, or the comparative
    // finding filed against the pair silently reads as fixed.
    const dark = shot("web/app/login/rest/desktop/dark");
    const light = shot("web/app/login/rest/desktop/light");
    const before = groupHash([dark, light]);
    const after = groupHash([dark, { ...light, hash: "hash-after-the-fix" }]);
    expect(after).not.toBe(before);
  });
});
