/**
 * Contact sheet: every shot of a run (or of one cluster) composited into a
 * single labelled image.
 *
 * lookout is run by a session that should see what lookout saw, but reading a
 * dozen full-resolution screenshots into that session costs more context than
 * the findings do. One sheet answers "what does this actually look like" in a
 * single Read, and the full-resolution paths stay listed beside it for close
 * reading. The judge never sees the sheet: it judges originals, because a
 * downscaled crop would hide the very defects it is looking for.
 *
 * Tiles are cropped from the top rather than letterboxed, so a very tall
 * full-page screenshot still shows its above-the-fold region at a readable
 * scale. Dark and light captures of one view sit side by side, which is the
 * comparison the rubric cares about most.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The minimum a tile needs. Structural rather than tied to ShotRecord, so the
 * backlog can composite a cluster's evidence without rehydrating capture
 * records it does not hold.
 */
export interface SheetShot {
  target: string;
  route: string;
  state: string;
  formFactor: string;
  scheme: string;
  /** Path relative to the evidence directory. */
  path: string;
}

const TILE_W = 420;
const TILE_H = 520;
const LABEL_H = 30;
const GAP = 10;
const MAX_COLS = 4;
/** Beyond this the sheet stops being readable, so it is capped and said so. */
export const MAX_TILES = 24;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Row key: one view at one form factor, so its schemes sit side by side. */
function rowKey(s: SheetShot): string {
  return `${s.target}|${s.route}|${s.state}|${s.formFactor}`;
}

export interface SheetTile {
  shot: SheetShot;
  /** Findings on this shot, drawn as a count badge. */
  findings?: number;
}

export interface SheetResult {
  path: string;
  tiles: number;
  omitted: number;
  columns: number;
  rows: number;
}

/**
 * Composite `tiles` into `outPath`. Returns null when there is nothing to draw
 * or sharp cannot read the inputs; a missing sheet must never fail a run.
 */
export async function buildContactSheet(
  tiles: SheetTile[],
  evidenceDir: string,
  outPath: string,
): Promise<SheetResult | null> {
  if (tiles.length === 0) return null;

  const ordered = [...tiles].sort((a, b) => {
    const ka = rowKey(a.shot);
    const kb = rowKey(b.shot);
    return ka.localeCompare(kb) || a.shot.scheme.localeCompare(b.shot.scheme);
  });
  const omitted = Math.max(0, ordered.length - MAX_TILES);
  const shown = ordered.slice(0, MAX_TILES);

  // Rows follow the view; a view wider than the cap wraps.
  const rows: SheetTile[][] = [];
  let currentKey: string | null = null;
  for (const t of shown) {
    const k = rowKey(t.shot);
    if (k !== currentKey || rows[rows.length - 1]!.length >= MAX_COLS) {
      rows.push([]);
      currentKey = k;
    }
    rows[rows.length - 1]!.push(t);
  }

  const columns = Math.max(...rows.map((r) => r.length));
  const cellH = TILE_H + LABEL_H;
  const width = columns * TILE_W + (columns + 1) * GAP;
  const height = rows.length * cellH + (rows.length + 1) * GAP;

  let sharp: typeof import("sharp").default;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return null;
  }

  const composites: { input: Buffer; top: number; left: number }[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r]!.length; c++) {
      const t = rows[r]![c]!;
      const left = GAP + c * (TILE_W + GAP);
      const top = GAP + r * (cellH + GAP);
      let img: Buffer;
      try {
        img = await sharp(join(evidenceDir, t.shot.path))
          .resize(TILE_W, TILE_H, { fit: "cover", position: "top" })
          .png()
          .toBuffer();
      } catch {
        continue; // a shot that will not decode simply leaves a gap
      }
      const badge = t.findings ? ` (${t.findings} finding${t.findings === 1 ? "" : "s"})` : "";
      const label =
        `${t.shot.route}${t.shot.state === "rest" ? "" : ` [${t.shot.state}]`}` +
        ` · ${t.shot.formFactor} · ${t.shot.scheme}${badge}`;
      const labelSvg = Buffer.from(
        `<svg width="${TILE_W}" height="${LABEL_H}">` +
          `<rect width="${TILE_W}" height="${LABEL_H}" fill="${t.findings ? "#7f1d1d" : "#1f2937"}"/>` +
          `<text x="8" y="20" font-family="sans-serif" font-size="14" fill="#f9fafb">${esc(label)}</text>` +
          `</svg>`,
      );
      composites.push({ input: labelSvg, top, left });
      composites.push({ input: img, top: top + LABEL_H, left });
    }
  }
  if (composites.length === 0) return null;

  const png = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 17, g: 24, b: 39 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, png);
  return { path: outPath, tiles: shown.length, omitted, columns, rows: rows.length };
}

/** The line telling a session to look at the sheet it just produced. */
export function sheetNote(sheet: SheetResult | null): string {
  if (!sheet) return "";
  return (
    `contact sheet: ${sheet.path}\n` +
    `  Read that image to see what was captured (${sheet.tiles} shot(s)` +
    (sheet.omitted ? `, ${sheet.omitted} not shown` : "") +
    `, cropped to the top of each page). Full-resolution shots are listed above.`
  );
}
