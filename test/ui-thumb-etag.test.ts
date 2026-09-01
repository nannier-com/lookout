/**
 * A thumbnail's ETag has to change when the thumbnail does.
 *
 * It is built from the file's path, mtime and size and the width and fit asked
 * for, which is the whole set of things that decide what comes back. That key
 * used to be base64-encoded and then truncated to 32 characters, and base64 is
 * a prefix code: 32 characters is the first 24 bytes of the key, which is the
 * front of an absolute path. Every thumbnail carried the same ETag and every
 * re-captured screenshot revalidated as unchanged, so the board went on showing
 * the defect that had just been fixed. That is the one thing a visual tester
 * must never do, and nothing in the suite noticed.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { thumbEtag } from "../src/ui/evidence.js";
import { tmpProject } from "./tmp-project.js";

const project = tmpProject("lookout-etag-");
const dir = join(project.projectDir, "shots");
mkdirSync(dir, { recursive: true });

/** A file at a path, with content, so its size and mtime are real. */
function shot(name: string, bytes: number, when?: Date): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  if (when) utimesSync(p, when, when);
  return p;
}

describe("what a thumbnail's ETag distinguishes", () => {
  test("a re-captured screenshot at the same path", () => {
    // The failure this guards: same path, new pixels, and the browser is told
    // nothing changed.
    const p = shot("shot.png", 100, new Date("2026-01-01T00:00:00Z"));
    const before = thumbEtag(p, 380, false);
    utimesSync(p, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    expect(thumbEtag(p, 380, false)).not.toBe(before);
  });

  test("a screenshot that changed size", () => {
    const p = shot("resized.png", 100, new Date("2026-01-01T00:00:00Z"));
    const before = thumbEtag(p, 380, false);
    writeFileSync(p, Buffer.alloc(200, 7));
    utimesSync(p, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(thumbEtag(p, 380, false)).not.toBe(before);
  });

  test("two widths of the same screenshot", () => {
    const p = shot("widths.png", 100);
    expect(thumbEtag(p, 380, false)).not.toBe(thumbEtag(p, 600, false));
  });

  test("the cropped tile and the whole contact sheet", () => {
    const p = shot("fit.png", 100);
    expect(thumbEtag(p, 380, false)).not.toBe(thumbEtag(p, 380, true));
  });

  test("two screenshots whose paths share a long prefix", () => {
    // The original bug in its purest form: these differ only past the first
    // twenty-four characters of an absolute path.
    const a = shot("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-one.png", 100);
    const b = shot("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-two.png", 100);
    expect(thumbEtag(a, 380, false)).not.toBe(thumbEtag(b, 380, false));
  });

  test("and the same request twice is the same ETag", () => {
    // Guard the guard: an ETag that simply never repeated would pass every
    // assertion above while defeating caching entirely.
    const p = shot("stable.png", 100, new Date("2026-01-01T00:00:00Z"));
    expect(thumbEtag(p, 380, false)).toBe(thumbEtag(p, 380, false));
  });
});
