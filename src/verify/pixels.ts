/**
 * How much two screenshots differ, and where.
 *
 * A ruling used to know only whether the pixels moved: `sha256(before) !==
 * sha256(after)`, a boolean in which a one-pixel nudge and a whole re-layout
 * are the same answer. That is enough to hold the guard that says nothing may
 * pass on unchanged pixels, and not enough to say anything to the person
 * reading the verdict about what the fix actually did.
 *
 * The comparison is exact: every channel, no tolerance, alpha ignored. lookout
 * captures with animations disabled at a fixed device scale, so two runs of an
 * unchanged page are byte-identical; a tolerance would only let a real change
 * hide under it. That is also why no perceptual metric is used here: SSIM and
 * its relatives score a one-pixel misalignment at ~1.0, which is exactly the
 * defect class this repository exists to file.
 *
 * The algorithm was `tools/ui-check`'s, where it found three real bugs that
 * every other gate passed over. It is promoted here rather than copied, and
 * that tool now imports it.
 */

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelDiff {
  /** Pixels differing, including every pixel one image has and the other does not. */
  changed: number;
  /** Pixels in the union of both images: max width x max height. */
  total: number;
  /** changed / total, 0 to 1. */
  fraction: number;
  /** The smallest rectangle containing every difference; null when there are none. */
  box: PixelBox | null;
  /**
   * changed / box area. Near 1 means one solid region moved; small means the
   * change is scattered, which is what a re-layout looks like.
   */
  density: number;
  before: { width: number; height: number };
  after: { width: number; height: number };
  /** The images are not the same size, which is itself a change. */
  sizeChanged: boolean;
}

/** The smallest box containing both, either of which may be absent. */
function union(a: PixelBox | null, b: PixelBox | null): PixelBox | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Decoded to three channels, so a PNG with alpha and one without compare alike. */
async function decode(src: Buffer | string) {
  const sharp = (await import("sharp")).default;
  return sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

/**
 * Compare two PNGs. Never throws: an image that will not decode returns null,
 * which callers read as "changed, and by how much was not measured" rather
 * than as "unchanged".
 *
 * Different dimensions are the common re-layout case, not an error. The
 * overlapping region is compared pixel by pixel and everything outside it
 * counts as changed, so a page that grew reports the growth rather than
 * refusing to answer.
 */
export async function diffPng(
  before: Buffer | string,
  after: Buffer | string,
): Promise<PixelDiff | null> {
  let a: Awaited<ReturnType<typeof decode>>;
  let b: Awaited<ReturnType<typeof decode>>;
  try {
    [a, b] = await Promise.all([decode(before), decode(after)]);
  } catch {
    return null;
  }

  const wA = a.info.width;
  const hA = a.info.height;
  const wB = b.info.width;
  const hB = b.info.height;
  const overlapW = Math.min(wA, wB);
  const overlapH = Math.min(hA, hB);
  const maxW = Math.max(wA, wB);
  const maxH = Math.max(hA, hB);
  const chan = 3;

  let changed = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < overlapH; y++) {
    const rowA = y * wA * chan;
    const rowB = y * wB * chan;
    for (let x = 0; x < overlapW; x++) {
      const ia = rowA + x * chan;
      const ib = rowB + x * chan;
      if (
        a.data[ia] !== b.data[ib] ||
        a.data[ia + 1] !== b.data[ib + 1] ||
        a.data[ia + 2] !== b.data[ib + 2]
      ) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  let box: PixelBox | null =
    maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;

  const sizeChanged = wA !== wB || hA !== hB;
  if (sizeChanged) {
    // Everything one image has and the other does not: the band to the right
    // of the narrower image, the band below the shorter one, or both.
    changed += maxW * maxH - overlapW * overlapH;
    if (maxW > overlapW) {
      box = union(box, { x: overlapW, y: 0, w: maxW - overlapW, h: maxH });
    }
    if (maxH > overlapH) {
      box = union(box, { x: 0, y: overlapH, w: maxW, h: maxH - overlapH });
    }
  }

  const total = maxW * maxH;
  const boxArea = box ? box.w * box.h : 0;
  return {
    changed,
    total,
    fraction: total > 0 ? changed / total : 0,
    box,
    density: boxArea > 0 ? changed / boxArea : 0,
    before: { width: wA, height: hA },
    after: { width: wB, height: hB },
    sizeChanged,
  };
}

/** Which third of the frame the box sits in, in the words a person would use. */
function whereIn(box: PixelBox, height: number): string {
  if (height <= 0) return "";
  const centre = box.y + box.h / 2;
  if (box.h >= height * 0.8) return "down the whole view";
  if (centre < height / 3) return "near the top";
  if (centre > (height * 2) / 3) return "near the bottom";
  return "in the middle";
}

/** A percentage a person can read: never "0.0%" for a change that happened. */
function pct(fraction: number): string {
  const p = fraction * 100;
  if (p >= 10) return `${p.toFixed(0)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  if (p >= 0.01) return `${p.toFixed(2)}%`;
  return "under 0.01%";
}

/**
 * What changed, as a sentence for the verdict. Says the shape of the change,
 * not just its size: one region moving and the same count scattered across the
 * frame mean different things to whoever is reading the ruling.
 */
export function changeSaid(d: PixelDiff): string {
  if (d.changed === 0) return "identical pixel for pixel";
  const parts: string[] = [];
  if (d.sizeChanged) {
    const dh = d.after.height - d.before.height;
    const dw = d.after.width - d.before.width;
    if (dh !== 0) parts.push(`the view is ${Math.abs(dh)}px ${dh > 0 ? "taller" : "shorter"}`);
    if (dw !== 0) parts.push(`the view is ${Math.abs(dw)}px ${dw > 0 ? "wider" : "narrower"}`);
  }
  let said = `${pct(d.fraction)} of pixels changed`;
  if (d.box) {
    const shape = d.density >= 0.6 ? "in one" : "scattered across a";
    said += `, ${shape} ${Math.round(d.box.w)}x${Math.round(d.box.h)} area ${whereIn(d.box, d.after.height)}`.trimEnd();
  }
  parts.push(said);
  return parts.join("; ");
}

/** Padding around a crop, so the change is seen in its context. */
const CROP_PAD = 14;
const CROP_MAX_WIDTH = 900;

/**
 * The changed region of the after image, cropped and enlarged. Best effort:
 * returns null rather than costing a ruling its verdict, because a picture of
 * the change is a convenience and the measurement is the evidence.
 */
export async function writeDiffCrop(
  afterPng: string,
  box: PixelBox,
  outPath: string,
): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(afterPng).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (imgW <= 0 || imgH <= 0) return null;
    // Padded on each side independently: a box against the frame's edge loses
    // the padding it cannot have, and does not silently gain it on the far side.
    const left = Math.max(0, Math.round(box.x) - CROP_PAD);
    const top = Math.max(0, Math.round(box.y) - CROP_PAD);
    const width = Math.min(imgW, Math.round(box.x + box.w) + CROP_PAD) - left;
    const height = Math.min(imgH, Math.round(box.y + box.h) + CROP_PAD) - top;
    if (width <= 0 || height <= 0) return null;
    await sharp(afterPng)
      .extract({ left, top, width, height })
      .resize({ width: Math.min(CROP_MAX_WIDTH, width * 3) })
      .png()
      .toFile(outPath);
    return outPath;
  } catch {
    return null;
  }
}
