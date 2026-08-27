// The contact sheet: everything a run saw, in one image.
//
// A session driving lookout should be able to see what lookout saw without
// spending more of its context on full-resolution screenshots than on the
// findings. The sheet is that, and it must never be able to fail a run: a
// missing sheet is a missing convenience, not a missing verdict.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContactSheet, sheetNote, MAX_TILES, type SheetShot } from "../src/capture/sheet.js";

const sharp = (await import("sharp")).default;

/** An evidence directory with real, decodable PNGs in it. */
async function evidence(shots: SheetShot[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lookout-sheet-"));
  for (const s of shots) {
    const file = join(dir, s.path);
    mkdirSync(join(file, ".."), { recursive: true });
    const png = await sharp({
      create: { width: 200, height: 400, channels: 3, background: { r: 40, g: 60, b: 90 } },
    })
      .png()
      .toBuffer();
    writeFileSync(file, png);
  }
  return dir;
}

function shot(over: Partial<SheetShot> = {}): SheetShot {
  const formFactor = over.formFactor ?? "desktop";
  const scheme = over.scheme ?? "dark";
  const route = over.route ?? "/dash";
  return {
    target: "app",
    route,
    state: "rest",
    formFactor,
    scheme,
    path: `${route.slice(1)}--${formFactor}-${scheme}.png`,
    ...over,
  };
}

describe("compositing", () => {
  test("a sheet is produced, and its tiles are laid out by view", async () => {
    const shots = [
      shot({ scheme: "dark" }),
      shot({ scheme: "light" }),
      shot({ route: "/settings", scheme: "dark" }),
      shot({ route: "/settings", scheme: "light" }),
    ];
    const dir = await evidence(shots);
    const out = join(dir, "contact-sheet.png");
    const res = await buildContactSheet(
      shots.map((s) => ({ shot: s })),
      dir,
      out,
    );

    expect(res).not.toBeNull();
    expect(res!.tiles).toBe(4);
    expect(res!.omitted).toBe(0);
    // Dark and light of one view sit side by side: that is the comparison the
    // rubric cares about most, so the sheet puts it in one glance.
    expect(res!.columns).toBe(2);
    expect(res!.rows).toBe(2);

    const meta = await sharp(out).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  test("nothing to draw is null rather than an empty image", async () => {
    const dir = await evidence([]);
    expect(await buildContactSheet([], dir, join(dir, "s.png"))).toBeNull();
  });

  test("a shot that will not decode leaves a gap instead of failing the run", async () => {
    // The sheet is a convenience. A run that captured evidence and judged it
    // must not fail because an image could not be composited.
    const good = shot();
    const dir = await evidence([good]);
    const broken = shot({ route: "/broken" });
    writeFileSync(join(dir, broken.path), "not a png");
    const res = await buildContactSheet(
      [{ shot: good }, { shot: broken }],
      dir,
      join(dir, "s.png"),
    );
    expect(res).not.toBeNull();
  });

  test("beyond the cap the extras are dropped and counted, never silently", async () => {
    const shots = Array.from({ length: MAX_TILES + 3 }, (_, i) => shot({ route: `/r${i}` }));
    const dir = await evidence(shots);
    const res = await buildContactSheet(
      shots.map((s) => ({ shot: s })),
      dir,
      join(dir, "s.png"),
    );
    expect(res!.tiles).toBe(MAX_TILES);
    expect(res!.omitted).toBe(3);
    expect(sheetNote(res)).toContain("3 not shown");
  });
});

describe("the note beside it", () => {
  test("says how to use the sheet, and says nothing when there is none", () => {
    expect(sheetNote(null)).toBe("");
    const note = sheetNote({ path: "/ev/s.png", tiles: 4, omitted: 0, columns: 2, rows: 2 });
    expect(note).toContain("/ev/s.png");
    expect(note).toContain("Read that image");
  });
});
