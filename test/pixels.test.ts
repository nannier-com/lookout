// How much two screenshots differ, and where.
//
// The ruling's guard used to be a byte hash, in which a one-pixel nudge and a
// whole re-layout are the same answer. These tests hold the replacement to
// three things the hash could not do: it measures, it locates, and it never
// throws, because a comparison that throws would cost a verdict.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeSaid, diffPng, writeDiffCrop } from "../src/verify/pixels.js";

const sharp = (await import("sharp")).default;

/** A plain image, optionally with rectangles painted on it. */
async function png(
  width: number,
  height: number,
  rects: { x: number; y: number; w: number; h: number }[] = [],
  opts: { alpha?: boolean } = {},
): Promise<Buffer> {
  const channels = opts.alpha ? 4 : 3;
  const background = opts.alpha
    ? { r: 10, g: 10, b: 10, alpha: 1 }
    : { r: 10, g: 10, b: 10 };
  const composite = await Promise.all(
    rects.map(async (r) => ({
      input: await sharp({
        create: { width: r.w, height: r.h, channels: 3, background: { r: 240, g: 240, b: 240 } },
      })
        .png()
        .toBuffer(),
      left: r.x,
      top: r.y,
    })),
  );
  return sharp({ create: { width, height, channels, background } })
    .composite(composite)
    .png()
    .toBuffer();
}

describe("diffPng", () => {
  test("identical images report no change and no region", async () => {
    const a = await png(64, 48, [{ x: 4, y: 4, w: 8, h: 8 }]);
    const d = (await diffPng(a, a))!;
    expect(d.changed).toBe(0);
    expect(d.box).toBeNull();
    expect(d.fraction).toBe(0);
    expect(d.sizeChanged).toBe(false);
    expect(d.total).toBe(64 * 48);
  });

  test("an image with alpha and one without compare alike", async () => {
    const plain = await png(32, 32);
    const withAlpha = await png(32, 32, [], { alpha: true });
    const d = (await diffPng(plain, withAlpha))!;
    expect(d.changed).toBe(0);
  });

  test("one painted rectangle is counted exactly and bounded exactly", async () => {
    const before = await png(64, 48);
    const after = await png(64, 48, [{ x: 20, y: 10, w: 10, h: 6 }]);
    const d = (await diffPng(before, after))!;
    expect(d.changed).toBe(60);
    expect(d.box).toEqual({ x: 20, y: 10, w: 10, h: 6 });
    expect(d.density).toBe(1);
  });

  test("two separated rectangles span both, and read as scattered", async () => {
    const before = await png(64, 48);
    const after = await png(64, 48, [
      { x: 2, y: 2, w: 4, h: 4 },
      { x: 50, y: 40, w: 4, h: 4 },
    ]);
    const d = (await diffPng(before, after))!;
    expect(d.changed).toBe(32);
    expect(d.box).toEqual({ x: 2, y: 2, w: 52, h: 42 });
    expect(d.density).toBeLessThan(0.6);
  });

  test("a taller image counts the new band as changed rather than throwing", async () => {
    const before = await png(64, 48);
    const after = await png(64, 60);
    const d = (await diffPng(before, after))!;
    expect(d.sizeChanged).toBe(true);
    // The 64x12 band the before image does not have.
    expect(d.changed).toBe(64 * 12);
    expect(d.total).toBe(64 * 60);
    expect(d.box).toEqual({ x: 0, y: 48, w: 64, h: 12 });
  });

  test("a wider image counts the new column band", async () => {
    const before = await png(48, 32);
    const after = await png(64, 32);
    const d = (await diffPng(before, after))!;
    expect(d.changed).toBe(16 * 32);
    expect(d.box).toEqual({ x: 48, y: 0, w: 16, h: 32 });
  });

  test("a shorter image is still a change, measured against the union", async () => {
    const before = await png(64, 60);
    const after = await png(64, 48);
    const d = (await diffPng(before, after))!;
    expect(d.sizeChanged).toBe(true);
    expect(d.changed).toBe(64 * 12);
    expect(d.total).toBe(64 * 60);
  });

  test("undecodable input returns null rather than throwing", async () => {
    const ok = await png(16, 16);
    expect(await diffPng(Buffer.from("not a png"), ok)).toBeNull();
    expect(await diffPng(ok, Buffer.from("not a png"))).toBeNull();
  });
});

describe("changeSaid", () => {
  test("no change says so in the words the ruling uses", async () => {
    const a = await png(32, 32);
    expect(changeSaid((await diffPng(a, a))!)).toBe("identical pixel for pixel");
  });

  test("one region names its size and where it sits", async () => {
    const before = await png(100, 300);
    const after = await png(100, 300, [{ x: 10, y: 10, w: 20, h: 20 }]);
    const said = changeSaid((await diffPng(before, after))!);
    expect(said).toContain("of pixels changed");
    expect(said).toContain("in one 20x20 area");
    expect(said).toContain("near the top");
  });

  test("scattered change is not described as one region", async () => {
    const before = await png(100, 300);
    const after = await png(100, 300, [
      { x: 2, y: 2, w: 4, h: 4 },
      { x: 90, y: 290, w: 4, h: 4 },
    ]);
    expect(changeSaid((await diffPng(before, after))!)).toContain("scattered across a");
  });

  test("a page that grew says so before it says how much moved", async () => {
    const before = await png(64, 48);
    const after = await png(64, 96);
    const said = changeSaid((await diffPng(before, after))!);
    expect(said.startsWith("the view is 48px taller")).toBe(true);
    expect(said).toContain("of pixels changed");
  });

  test("a tiny change is never rounded away to zero percent", async () => {
    const before = await png(400, 400);
    const after = await png(400, 400, [{ x: 0, y: 0, w: 2, h: 2 }]);
    expect(changeSaid((await diffPng(before, after))!)).toContain("under 0.01%");
  });
});

describe("writeDiffCrop", () => {
  test("a box at the frame's edge is clamped rather than refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-pixels-"));
    const file = join(dir, "after.png");
    await sharp(await png(64, 48, [{ x: 0, y: 0, w: 6, h: 6 }])).toFile(file);
    const out = join(dir, "crop.png");
    expect(await writeDiffCrop(file, { x: 0, y: 0, w: 6, h: 6 }, out)).toBe(out);
    expect(existsSync(out)).toBe(true);
    const meta = await sharp(out).metadata();
    // 6 + 14 of padding on the inside edges only, then tripled.
    expect(meta.width).toBe(60);
  });

  test("a missing image costs the crop, never the caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-pixels-"));
    const out = join(dir, "crop.png");
    expect(await writeDiffCrop(join(dir, "absent.png"), { x: 0, y: 0, w: 4, h: 4 }, out)).toBeNull();
    expect(existsSync(out)).toBe(false);
  });
});
