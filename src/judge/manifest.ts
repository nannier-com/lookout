/**
 * How a screenshot is described to a model, in one place.
 *
 * The judge, the refuter, the criteria verifier and the fact-checker each
 * hand a model a list of shots. They used to each write their own lines, and
 * the lines drifted: one said the size, one did not, none said which form
 * factors the batch was missing. What a model is told about a shot is part of
 * what it can rule on, so it is written once here.
 *
 * Two things this module knows that the callers do not. First, what a batch
 * covers: the header names the form factors and schemes present and the ones
 * not captured, so a run narrowed with `--viewports` never invites a claim
 * about a form factor that is not in front of the model. Second, how tall an
 * image a model can actually read. Measured on 2026-09-02 with the judge's
 * own model and tool: a 7802 px tall capture was transcribed exactly, an
 * 11202 px one came back with digits and letters misread, and a 29500 px one
 * was "downscaled so heavily that all text is illegible". So a shot taller
 * than MAX_IMAGE_PX is handed over in pieces cut from the same bytes, each a
 * whole number of screens, and the model is told to read the pieces instead
 * of the file. The file stays the shot: its hash is the ledger key, its path
 * is what an issue freezes; the pieces are working evidence, rebuilt whenever
 * the shot's hash changes.
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_VIEWPORTS,
  DEVICE_SCALE_FACTOR,
  FORM_FACTORS,
  SCHEMES,
  type FormFactor,
  type Scheme,
  type ShotRecord,
} from "../types.js";

/** The tallest image the judge reads exactly; see the header for the measurement. */
export const MAX_IMAGE_PX = 8000;
/** Pieces beyond this are not cut: a page that long is a page nobody scrolls. */
export const MAX_PIECES = 8;

/** Evidence-relative piece paths by shot id. Absent means the file is read whole. */
export type Pieces = ReadonlyMap<string, readonly string[]>;

type Axes = Pick<ShotRecord, "formFactor" | "scheme" | "platform">;

/**
 * What the batch holds, said before the shots. The form factors and schemes
 * present in walk order, and the ones of the full set that were not captured,
 * because a form factor missing from a batch and a form factor found clean
 * look the same in a list of shots.
 */
export function batchHeader(shots: readonly Axes[]): string {
  const present = <T extends string>(all: readonly T[], of: (s: Axes) => T): string => {
    const here = all.filter((v) => shots.some((s) => of(s) === v));
    const missing = all.filter((v) => !here.includes(v));
    return here.join(", ") + (missing.length > 0 ? ` (not captured: ${missing.join(", ")})` : "");
  };
  const platforms = [...new Set(shots.map((s) => s.platform))];
  return [
    `platform${platforms.length === 1 ? "" : "s"}: ${platforms.join(", ")}`,
    `formFactors: ${present<FormFactor>(FORM_FACTORS, (s) => s.formFactor)}`,
    `schemes: ${present<Scheme>(SCHEMES, (s) => s.scheme)}`,
  ].join("\n");
}

/** One screen's height in PNG pixels: what a piece is a whole number of. */
export function screenHeight(shot: Pick<ShotRecord, "formFactor" | "viewport" | "dpr">): number {
  const css = shot.viewport?.height ?? DEFAULT_VIEWPORTS[shot.formFactor].height;
  return Math.max(1, Math.round(css * (shot.dpr ?? DEVICE_SCALE_FACTOR)));
}

/** The tallest piece that is a whole number of screens and still reads exactly. */
export function pieceHeight(shot: Pick<ShotRecord, "formFactor" | "viewport" | "dpr">): number {
  const screen = screenHeight(shot);
  return screen >= MAX_IMAGE_PX ? MAX_IMAGE_PX : Math.floor(MAX_IMAGE_PX / screen) * screen;
}

/** Whether a shot is handed over in pieces at all. */
export function needsPieces(shot: Pick<ShotRecord, "height">): boolean {
  return shot.height > MAX_IMAGE_PX;
}

/** The rows each piece covers, top to bottom, capped at MAX_PIECES. */
export function pieceBands(shot: Pick<ShotRecord, "formFactor" | "viewport" | "dpr" | "height">): { top: number; height: number }[] {
  const step = pieceHeight(shot);
  const bands: { top: number; height: number }[] = [];
  for (let top = 0; top < shot.height && bands.length < MAX_PIECES; top += step) {
    bands.push({ top, height: Math.min(step, shot.height - top) });
  }
  return bands;
}

function pieceRel(shot: Pick<ShotRecord, "path">, index: number, count: number): string {
  return shot.path.replace(/\.png$/, "") + `.p${index}of${count}.png`;
}

function markerRel(shot: Pick<ShotRecord, "path">): string {
  return shot.path + ".pieces.json";
}

/**
 * Cut the pieces for every shot that needs them, once per shot hash, and say
 * which files each shot is now read from. A shot whose file cannot be cut is
 * left out of the map and read whole, which is what happened before pieces
 * existed; a missing file fails the model's own Read just as it always did.
 */
export async function preparePieces(evidenceDir: string, shots: readonly ShotRecord[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const shot of shots) {
    if (!needsPieces(shot)) continue;
    const marker = join(evidenceDir, markerRel(shot));
    try {
      const prior = JSON.parse(await readFile(marker, "utf8")) as { shotHash?: string; pieces?: string[] };
      if (prior.shotHash === shot.hash && Array.isArray(prior.pieces) && prior.pieces.length > 0) {
        out.set(shot.id, prior.pieces);
        continue;
      }
      for (const stale of prior.pieces ?? []) await unlink(join(evidenceDir, stale)).catch(() => {});
    } catch {
      // No marker, or an unreadable one: cut afresh.
    }
    try {
      const sharp = (await import("sharp")).default;
      const source = join(evidenceDir, shot.path);
      const bands = pieceBands(shot);
      const pieces: string[] = [];
      for (const [i, band] of bands.entries()) {
        const rel = pieceRel(shot, i + 1, bands.length);
        await sharp(source)
          .extract({ left: 0, top: band.top, width: shot.width, height: band.height })
          .png()
          .toFile(join(evidenceDir, rel));
        pieces.push(rel);
      }
      await writeFile(marker, JSON.stringify({ shotHash: shot.hash, pieces }, null, 2));
      out.set(shot.id, pieces);
    } catch {
      // The shot is read whole, as before pieces existed.
    }
  }
  return out;
}

/**
 * The lines telling a model to read a shot in pieces, or none when it is read
 * whole. `indent` is the caller's, so the block sits under its shot however
 * the caller lays its list out.
 */
export function pieceLines(shot: ShotRecord, evidenceDir: string, pieces: Pieces | undefined, indent = "  "): string[] {
  const files = pieces?.get(shot.id);
  if (!files || files.length === 0) return [];
  const covered = pieceBands(shot).reduce((sum, b) => sum + b.height, 0);
  const rest = shot.height - covered;
  return [
    `${indent}pieces: the file is ${shot.height} px tall, too tall to read whole; read these ${files.length} pieces top to bottom instead, each a whole number of screens, and file against the shotId above` +
      (rest > 0 ? ` (the page continues ${rest} px below the last piece)` : ""),
    ...files.map((rel, i) => `${indent}  - ${evidenceDir}/${rel}  (piece ${i + 1} of ${files.length})`),
  ];
}

/** The files a model has to open to have looked at a shot: its pieces when it has them, else the file. */
export function filesOf(shot: Pick<ShotRecord, "id" | "path">, pieces?: Pieces): readonly string[] {
  const cut = pieces?.get(shot.id);
  return cut && cut.length > 0 ? cut : [shot.path];
}

/**
 * Whether a model opened every file a shot is read from. A Read names a
 * path as the model typed it, absolute or relative to the evidence
 * directory it was run in, so both spellings are resolved before comparing.
 */
export function wasRead(
  shot: Pick<ShotRecord, "id" | "path">,
  evidenceDir: string,
  pieces: Pieces | undefined,
  reads: readonly string[],
): boolean {
  const opened = new Set(reads.map((r) => resolve(evidenceDir, r)));
  return filesOf(shot, pieces).every((rel) => opened.has(resolve(evidenceDir, rel)));
}

/** A shot's entry in a manifest: its id, its file, its axes and, when cut, its pieces. */
export function shotEntry(shot: ShotRecord, evidenceDir: string, pieces?: Pieces): string {
  return [
    `- shotId: ${shot.id}`,
    `  file: ${evidenceDir}/${shot.path}`,
    `  route: ${shot.route} (${shot.routeName})  state: ${shot.state}  formFactor: ${shot.formFactor}  scheme: ${shot.scheme}  size: ${shot.width}x${shot.height}`,
    ...pieceLines(shot, evidenceDir, pieces),
  ].join("\n");
}

/** The whole manifest: the header, then every shot. */
export function manifestOf(shots: readonly ShotRecord[], evidenceDir: string, pieces?: Pieces, extra?: (s: ShotRecord) => string): string {
  return [batchHeader(shots), ...shots.map((s) => shotEntry(s, evidenceDir, pieces) + (extra?.(s) ?? ""))].join("\n");
}
