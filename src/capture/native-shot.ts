/**
 * One photograph of one device: the deep link, the retries behind the blank
 * and stale-frame guards, and the scheme read-back. Split from native.ts,
 * which owns the device walk, so a screen walk can photograph a device it has
 * navigated to without re-walking every route.
 *
 * Recipes learned the hard way:
 * - Blank guard: a painted screen is hundreds of KB of PNG; a splash is tiny.
 * - Stale-frame guard: grayscale-downsample each grab and compare against the
 *   last accepted frame on that device; near-identical means the app is still
 *   showing the previous route.
 * - Scheme read-back: mean luminance decides whether a shot is actually dark
 *   or light; a shot contradicting its label is an error, never a silent lie.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeterministicFinding, NativeAppConfig, Scheme } from "../types.js";
import { shotRelPath, type ShotAxes } from "./store.js";
import { androidOpen, androidShot } from "./native-android.js";
import { iosOpen, iosShot } from "./native-ios.js";
import { adbBin, type NativeDevice } from "./native-device.js";
import { execFileAsync, sleep } from "../util.js";

const BLANK_BYTES = 60_000;
const STALE_MAD = 4;
const RETRIES = 4;

export async function fingerprint(png: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(png).resize(64, 139, { fit: "fill" }).grayscale().raw().toBuffer();
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 255;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n;
}

async function meanLuminance(png: Buffer): Promise<number> {
  const sharp = (await import("sharp")).default;
  const stats = await sharp(png).grayscale().stats();
  return stats.channels[0]?.mean ?? 128;
}

/** dark <60, light >180, otherwise inconclusive (null). */
export function schemeFromLuminance(mean: number): Scheme | null {
  if (mean < 60) return "dark";
  if (mean > 180) return "light";
  return null;
}

/**
 * The deep link for a route. The scheme rides in the query only when the app
 * declared a parameter for it; otherwise the device's own appearance is
 * switched (`setDeviceAppearance`) and the link says nothing about it.
 */
export function deepLink(app: NativeAppConfig, routePath: string, scheme: Scheme): string {
  const url = new URL(`${app.deepLinkScheme}:///${routePath.replace(/^\//, "")}`);
  if (app.appearanceParam) url.searchParams.set(app.appearanceParam, scheme);
  return url.toString();
}

/** The command that switches a device's appearance; pure, so a test can read it. */
export function appearanceCommand(device: NativeDevice, scheme: Scheme): { bin: string; args: string[] } {
  return device.platform === "ios"
    ? { bin: "xcrun", args: ["simctl", "ui", device.id, "appearance", scheme] }
    : { bin: adbBin(), args: ["-s", device.id, "shell", "cmd", "uimode", "night", scheme === "dark" ? "yes" : "no"] };
}

/**
 * Switch the device itself to a scheme, for apps that follow the system
 * appearance rather than a deep-link parameter. Best effort: the luminance
 * read-back on the shot that follows is what says whether it took.
 */
export async function setDeviceAppearance(device: NativeDevice, scheme: Scheme): Promise<void> {
  const { bin, args } = appearanceCommand(device, scheme);
  await execFileAsync(bin, args, { timeout: 30_000 });
}

export async function openOnDevice(device: NativeDevice, bundleId: string, url: string): Promise<void> {
  if (device.platform === "ios") await iosOpen(device.id, bundleId, url);
  else await androidOpen(device.id, bundleId, url);
}

export async function shootDevice(device: NativeDevice, file: string): Promise<void> {
  if (device.platform === "ios") await iosShot(device.id, file);
  else await androidShot(device.id, file);
}

export interface DeviceShotOptions {
  scheme: Scheme;
  /** The deep link to cold-start the app on before each attempt. */
  url: string;
  /** How long the app gets to paint after the cold start. */
  settleMs: number;
  evidenceDir: string;
  /** The last accepted frame on this device, for the stale guard; null before the first. */
  lastFrame: Buffer | null;
  progress: (line: string) => void;
}

export interface DeviceShot {
  png: Buffer;
  /** Evidence-relative path the PNG was written to. */
  rel: string;
  findings: DeterministicFinding[];
  /** The frame to seed the next shot's stale guard with. */
  lastFrame: Buffer;
}

/**
 * Cold-start the app on the deep link and photograph it, retrying past blank
 * and stale frames; then read the scheme back off the pixels.
 */
export async function photographDevice(
  device: NativeDevice,
  app: NativeAppConfig,
  axes: ShotAxes,
  opts: DeviceShotOptions,
): Promise<DeviceShot> {
  const label = `${device.platform} ${device.formFactor} ${axes.route}`;
  const rel = shotRelPath(axes);
  const abs = join(opts.evidenceDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  let png: Buffer | null = null;
  let lastFrame = opts.lastFrame;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    await openOnDevice(device, app.bundleId, opts.url);
    await sleep(opts.settleMs);
    await shootDevice(device, abs);
    const candidate = await readFile(abs);
    if (candidate.byteLength < BLANK_BYTES) {
      opts.progress(`${label}: blank frame (${candidate.byteLength}b), retry ${attempt}/${RETRIES}`);
      await sleep(4000);
      continue;
    }
    const fp = await fingerprint(candidate);
    if (lastFrame && meanAbsDiff(fp, lastFrame) < STALE_MAD) {
      opts.progress(`${label}: stale frame, retry ${attempt}/${RETRIES}`);
      await sleep(4000);
      continue;
    }
    lastFrame = fp;
    png = candidate;
    break;
  }
  if (!png || !lastFrame) throw new Error(`no fresh painted frame after ${RETRIES} attempts`);

  // Scheme read-back: an inconclusive read is informational; a contradicting
  // read is an error (mislabeled evidence poisons every downstream judgment).
  const findings: DeterministicFinding[] = [];
  const lum = await meanLuminance(png);
  const measured = schemeFromLuminance(lum);
  if (measured && measured !== opts.scheme) {
    findings.push({
      type: "scheme-mismatch",
      severity: "error",
      message: `requested ${opts.scheme} but the screen reads ${measured} (mean luminance ${lum.toFixed(0)})`,
    });
  }
  return { png, rel, findings, lastFrame };
}
