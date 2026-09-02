// Which screenshots moved, and by how much.
//
// The guard that nothing passes on unchanged pixels used to be a hash
// comparison. These hold the replacement to being no weaker than it: a
// measurement may only ever move a shot from changed to unchanged, and only by
// proving the two images are the same.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyShots, largestMove, measureMoves, movesRecorded, snapshotBaseline } from "../src/verify/moved.js";
import type { PixelDiff } from "../src/verify/pixels.js";
import type { ShotRecord } from "../src/types.js";

const sharp = (await import("sharp")).default;

function diff(over: Partial<PixelDiff> = {}): PixelDiff {
  return {
    changed: 100,
    total: 10000,
    fraction: 0.01,
    box: { x: 0, y: 0, w: 10, h: 10 },
    density: 1,
    before: { width: 100, height: 100 },
    after: { width: 100, height: 100 },
    sizeChanged: false,
    ...over,
  };
}

function shot(id: string, hash: string): Pick<ShotRecord, "id" | "hash"> {
  return { id, hash };
}

describe("classifyShots", () => {
  test("a shot with no baseline is neither changed nor comparable", () => {
    const out = classifyShots({
      shots: [shot("a", "h2")],
      priorHashes: new Map(),
      measured: new Map(),
    });
    expect(out.changedShots.size).toBe(0);
    expect(out.baselineShots).toBe(0);
  });

  test("a matching hash did not move, and is never measured", () => {
    const out = classifyShots({
      shots: [shot("a", "h1")],
      priorHashes: new Map([["a", "h1"]]),
      measured: new Map(),
    });
    expect(out.changedShots.size).toBe(0);
    expect(out.baselineShots).toBe(1);
    expect(out.changes.size).toBe(0);
  });

  test("a differing hash moved, even when nothing could measure it", () => {
    const out = classifyShots({
      shots: [shot("a", "h2")],
      priorHashes: new Map([["a", "h1"]]),
      measured: new Map(),
    });
    expect([...out.changedShots]).toEqual(["a"]);
    expect(out.changes.size).toBe(0);
  });

  test("a differing hash over identical pixels did not move", () => {
    // A Chromium upgrade between filing and ruling re-encodes the same image to
    // different bytes. The hash alone called that a fix.
    const out = classifyShots({
      shots: [shot("a", "h2")],
      priorHashes: new Map([["a", "h1"]]),
      measured: new Map([["a", diff({ changed: 0, fraction: 0, box: null, density: 0 })]]),
    });
    expect(out.changedShots.size).toBe(0);
    expect(out.baselineShots).toBe(1);
    expect(out.changes.size).toBe(0);
  });

  test("a measured move is both counted and kept", () => {
    const out = classifyShots({
      shots: [shot("a", "h2"), shot("b", "h9")],
      priorHashes: new Map([["a", "h1"], ["b", "h9"]]),
      measured: new Map([["a", diff()]]),
    });
    expect([...out.changedShots]).toEqual(["a"]);
    expect(out.baselineShots).toBe(2);
    expect(out.changes.get("a")!.changed).toBe(100);
  });
});

describe("snapshotBaseline and measureMoves", () => {
  async function workspace(): Promise<{ dir: string; before: string }> {
    const dir = mkdtempSync(join(tmpdir(), "lookout-moved-"));
    const before = join(dir, "before.png");
    writeFileSync(
      before,
      await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(),
    );
    return { dir, before };
  }

  test("pixels are read before the capture writes over them", async () => {
    const { before } = await workspace();
    const kept = await snapshotBaseline(new Map([["a", before]]));
    expect(kept.get("a")!.byteLength).toBeGreaterThan(0);
  });

  test("a baseline file that is gone leaves the shot unmeasured, never unchanged", async () => {
    const kept = await snapshotBaseline(new Map([["a", "/nowhere/absent.png"]]));
    expect(kept.size).toBe(0);
  });

  test("only shots whose hash moved and whose pixels were kept are compared", async () => {
    const { dir, before } = await workspace();
    const after = join(dir, "after.png");
    writeFileSync(
      after,
      await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer(),
    );
    const kept = await snapshotBaseline(new Map([["a", before], ["b", before]]));
    const shots = [
      { id: "a", hash: "h2", path: "after.png" },
      { id: "b", hash: "h1", path: "after.png" },
    ] as ShotRecord[];
    const out = await measureMoves({
      shots,
      priorHashes: new Map([["a", "h1"], ["b", "h1"]]),
      before: kept,
      evidenceDir: dir,
    });
    // "b" never moved, so it was never decoded.
    expect([...out.keys()]).toEqual(["a"]);
    expect(out.get("a")!.changed).toBe(400);
  });
});

describe("movesRecorded", () => {
  test("largest first, capped, with the sentence beside the numbers", () => {
    const changes = new Map([
      ["small", diff({ fraction: 0.001 })],
      ["big", diff({ fraction: 0.5 })],
    ]);
    const out = movesRecorded(changes, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.shotId).toBe("big");
    expect(out[0]!.said).toContain("of pixels changed");
  });

  test("a size change is flagged so the record does not have to infer it", () => {
    const out = movesRecorded(new Map([["a", diff({ sizeChanged: true })]]));
    expect(out[0]!.sizeChanged).toBe(true);
  });

  test("nothing measured records nothing", () => {
    expect(movesRecorded(new Map())).toEqual([]);
  });
});

describe("largestMove", () => {
  test("the biggest fraction wins, and an empty map has no answer", () => {
    expect(largestMove(new Map())).toBeNull();
    const out = largestMove(new Map([["a", diff({ fraction: 0.1 })], ["b", diff({ fraction: 0.9 })]]));
    expect(out!.shotId).toBe("b");
  });
});
