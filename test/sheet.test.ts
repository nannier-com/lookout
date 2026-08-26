// Contact sheet tests: real compositing through sharp, so the image the
// session is told to read is proven to exist and to have the shape claimed.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContactSheet, sheetNote, MAX_TILES, type SheetShot } from "../src/capture/sheet.js";

let dir = "";

function shot(route: string, formFactor: string, scheme: string): SheetShot {
  return { target: "app", route, state: "rest", formFactor, scheme, path: `${route.slice(1)}-${formFactor}-${scheme}.png` };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lookout-sheet-"));
  const sharp = (await import("sharp")).default;
  for (const route of ["/login", "/home"]) {
    for (const ff of ["desktop", "phone"]) {
      for (const sc of ["dark", "light"]) {
        const png = await sharp({
          create: { width: 200, height: 900, channels: 3, background: sc === "dark" ? "#111" : "#eee" },
        })
          .png()
          .toBuffer();
        await writeFile(join(dir, shot(route, ff, sc).path), png);
      }
    }
  }
});

describe("buildContactSheet", () => {
  test("composites every shot and puts a view's schemes on one row", async () => {
    const tiles = ["/login", "/home"].flatMap((r) =>
      ["desktop", "phone"].flatMap((ff) => ["dark", "light"].map((sc) => ({ shot: shot(r, ff, sc) }))),
    );
    const out = join(dir, "sheet.png");
    const res = await buildContactSheet(tiles, dir, out);
    expect(res).not.toBeNull();
    expect(res!.tiles).toBe(8);
    expect(res!.omitted).toBe(0);
    // Four views (2 routes x 2 form factors), each a row of its two schemes.
    expect(res!.rows).toBe(4);
    expect(res!.columns).toBe(2);
    expect((await stat(out)).size).toBeGreaterThan(1000);
  });

  test("marks the tiles that carry findings", async () => {
    const out = join(dir, "marked.png");
    const res = await buildContactSheet(
      [{ shot: shot("/login", "desktop", "dark"), findings: 3 }],
      dir,
      out,
    );
    expect(res!.tiles).toBe(1);
    expect(sheetNote(res)).toContain("Read that image");
    expect(sheetNote(res)).toContain(out);
  });

  test("caps an unreadably large sheet and says how many it dropped", async () => {
    const many = Array.from({ length: MAX_TILES + 5 }, (_, i) => ({
      shot: { ...shot("/login", `ff${i}`, "dark"), path: shot("/login", "desktop", "dark").path },
    }));
    const res = await buildContactSheet(many, dir, join(dir, "capped.png"));
    expect(res!.tiles).toBe(MAX_TILES);
    expect(res!.omitted).toBe(5);
    expect(sheetNote(res)).toContain("5 not shown");
  });

  test("nothing to draw is null, not a crash", async () => {
    expect(await buildContactSheet([], dir, join(dir, "empty.png"))).toBeNull();
  });

  test("an undecodable shot leaves a gap rather than failing the run", async () => {
    await mkdir(join(dir, "broken"), { recursive: true });
    await writeFile(join(dir, "not-a-png.png"), "definitely not a png");
    const res = await buildContactSheet(
      [{ shot: { ...shot("/login", "desktop", "dark"), path: "not-a-png.png" } }, { shot: shot("/home", "desktop", "dark") }],
      dir,
      join(dir, "partial.png"),
    );
    expect(res).not.toBeNull();
  });
});
