// How a shot is described to a model: the batch header that says what was and
// was not captured, and the pieces a tall shot is read in. The piece limit is
// the measured one (a 7802 px capture read exactly, an 11202 px one misread),
// pinned as a literal so a change to it is a change to this file.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  MAX_IMAGE_PX,
  MAX_PIECES,
  batchHeader,
  manifestOf,
  needsPieces,
  pieceBands,
  pieceHeight,
  preparePieces,
  shotEntry,
} from "../src/judge/manifest.js";
import type { ShotRecord } from "../src/types.js";

const shot = (over: Partial<ShotRecord>): ShotRecord => ({
  id: `web/app/root/rest/${over.formFactor ?? "desktop"}/${over.scheme ?? "dark"}`,
  target: "app",
  route: "/",
  routeName: "root",
  state: "rest",
  platform: "web",
  formFactor: "desktop",
  scheme: "dark",
  path: `web/app/root/rest--${over.formFactor ?? "desktop"}-${over.scheme ?? "dark"}.png`,
  hash: "h1",
  bytes: 1,
  width: 2880,
  height: 1800,
  animated: false,
  capturedAt: "t",
  runId: "r",
  deterministicFindings: [],
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the batch header", () => {
  test("names every form factor and scheme present, in walk order", () => {
    const shots = [
      shot({ formFactor: "phone", scheme: "light" }),
      shot({ formFactor: "desktop", scheme: "dark" }),
      shot({ formFactor: "tablet", scheme: "dark" }),
      shot({ formFactor: "phone", scheme: "dark" }),
      shot({ formFactor: "desktop", scheme: "light" }),
      shot({ formFactor: "tablet", scheme: "light" }),
    ];
    expect(batchHeader(shots)).toBe("platform: web\nformFactors: desktop, tablet, phone\nschemes: dark, light");
  });

  test("says which form factors and schemes were not captured", () => {
    const shots = [shot({ formFactor: "phone" }), shot({ formFactor: "desktop" })];
    expect(batchHeader(shots)).toBe(
      "platform: web\nformFactors: desktop, phone (not captured: tablet)\nschemes: dark (not captured: light)",
    );
  });

  test("lists the platforms when a manifest mixes them", () => {
    const shots = [shot({}), shot({ platform: "ios", formFactor: "phone" })];
    expect(batchHeader(shots)).toStartWith("platforms: web, ios\n");
  });

  test("comes first in a manifest, before the shots", () => {
    const text = manifestOf([shot({})], "/ev");
    expect(text.indexOf("formFactors:")).toBeLessThan(text.indexOf("- shotId:"));
    expect(text).toContain("- shotId: web/app/root/rest/desktop/dark\n  file: /ev/web/app/root/rest--desktop-dark.png\n  route: / (root)  state: rest  formFactor: desktop  scheme: dark  size: 2880x1800");
  });
});

describe("pieces", () => {
  test("the limit is the measured one", () => {
    expect(MAX_IMAGE_PX).toBe(8000);
    expect(MAX_PIECES).toBe(8);
  });

  test("a shot no taller than the limit is read whole", () => {
    expect(needsPieces(shot({ height: 8000 }))).toBe(false);
    expect(needsPieces(shot({ height: 8001 }))).toBe(true);
  });

  test("a piece is the tallest whole number of screens under the limit", () => {
    // A phone screen is 844 css px at 2x: four of them fit under 8000.
    expect(pieceHeight(shot({ formFactor: "phone", viewport: { width: 390, height: 844 }, dpr: 2 }))).toBe(6752);
    // The preset stands in when the record carries no viewport.
    expect(pieceHeight(shot({ formFactor: "desktop" }))).toBe(7200);
    // A screen taller than the limit is cut at the limit itself.
    expect(pieceHeight(shot({ viewport: { width: 100, height: 9000 }, dpr: 1 }))).toBe(8000);
  });

  test("bands cover the shot top to bottom, the last one short, capped", () => {
    const bands = pieceBands(shot({ formFactor: "phone", viewport: { width: 390, height: 844 }, dpr: 2, height: 11202 }));
    expect(bands).toEqual([{ top: 0, height: 6752 }, { top: 6752, height: 4450 }]);
    const many = pieceBands(shot({ formFactor: "phone", viewport: { width: 390, height: 844 }, dpr: 2, height: 100_000 }));
    expect(many.length).toBe(MAX_PIECES);
  });

  test("a tall shot is cut into files beside it, once per hash, and named in its entry", async () => {
    const ev = mkdtempSync(join(tmpdir(), "lookout-pieces-"));
    dirs.push(ev);
    mkdirSync(join(ev, "web/app/root"), { recursive: true });
    const tall = shot({ formFactor: "phone", viewport: { width: 390, height: 844 }, dpr: 2, width: 780, height: 11202 });
    await sharp({ create: { width: 780, height: 11202, channels: 3, background: "#123456" } }).png().toFile(join(ev, tall.path));
    const pieces = await preparePieces(ev, [tall, shot({})]);
    expect(pieces.get(tall.id)).toEqual(["web/app/root/rest--phone-dark.p1of2.png", "web/app/root/rest--phone-dark.p2of2.png"]);
    expect(pieces.has(shot({}).id)).toBe(false);
    const first = await sharp(join(ev, "web/app/root/rest--phone-dark.p1of2.png")).metadata();
    const second = await sharp(join(ev, "web/app/root/rest--phone-dark.p2of2.png")).metadata();
    expect([first.width, first.height, second.height]).toEqual([780, 6752, 4450]);
    const marker = JSON.parse(readFileSync(join(ev, tall.path + ".pieces.json"), "utf8")) as { shotHash: string };
    expect(marker.shotHash).toBe("h1");
    // The same hash is not cut again; a new hash replaces the set.
    const again = await preparePieces(ev, [tall]);
    expect(again.get(tall.id)).toEqual(pieces.get(tall.id));
    const shorter = { ...tall, hash: "h2", height: 7000 };
    await sharp({ create: { width: 780, height: 7000, channels: 3, background: "#654321" } }).png().toFile(join(ev, tall.path));
    const after = await preparePieces(ev, [shorter]);
    expect(after.has(tall.id)).toBe(false);

    const entry = shotEntry(tall, ev, pieces);
    expect(entry).toContain("pieces: the file is 11202 px tall, too tall to read whole; read these 2 pieces top to bottom instead");
    expect(entry).toContain(`    - ${ev}/web/app/root/rest--phone-dark.p1of2.png  (piece 1 of 2)`);
    expect(existsSync(join(ev, "web/app/root/rest--phone-dark.p1of2.png"))).toBe(true);
  });

  test("a shot whose file is missing is read whole rather than failing the batch", async () => {
    const ev = mkdtempSync(join(tmpdir(), "lookout-pieces-"));
    dirs.push(ev);
    const pieces = await preparePieces(ev, [shot({ height: 20_000 })]);
    expect(pieces.size).toBe(0);
  });
});
