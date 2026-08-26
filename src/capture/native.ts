/**
 * Native capture adapters: iOS simulator and Android emulator. Generic over
 * any app that exposes a deep-link scheme; the per-project config supplies
 * deepLinkScheme, bundleId, and settle times.
 *
 * Recipes proven in canvas's capture-looks pipeline:
 * - Android MUST `am force-stop` before every VIEW intent: an intent delivered
 *   to a running activity is swallowed and the router never moves, banking a
 *   screenshot of the previous page. No retry fixes it; only the force-stop.
 * - Blank guard: a painted screen is hundreds of KB of PNG; a splash is tiny.
 * - Stale-frame guard: grayscale-downsample each grab and compare against the
 *   last accepted frame on that platform; near-identical means the app is
 *   still showing the previous route.
 * - Scheme read-back: mean luminance decides whether a shot is actually dark
 *   or light; a shot contradicting its label is an error, never a silent lie.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LookoutError,
  type DeterministicFinding,
  type NativeAppConfig,
  type PlatformKind,
  type ResolvedConfig,
  type RunRecord,
  type Scheme,
  type ShotRecord,
} from "../types.js";
import type { ResolvedTarget } from "../targets.js";
import { evidenceDir } from "../config.js";
import { shotId, shotRelPath, type ShotAxes } from "./store.js";
import { execFileAsync, nowIso, sha256, sleep } from "../util.js";

const BLANK_BYTES = 60_000;
const STALE_MAD = 4;
const RETRIES = 4;

export interface NativeCaptureOptions {
  platforms: ("ios" | "android")[];
  schemes: Scheme[];
  runId: string;
  onProgress?: (line: string) => void;
  /** Called as each shot lands, so a live watcher sees it appear mid-run. */
  onShot?: (shot: ShotRecord) => void;
}

export interface NativeCaptureResult {
  run: RunRecord;
  shots: ShotRecord[];
}

function adbBin(): string {
  return process.env.ADB ?? "adb";
}

// ---------------------------------------------------------------------------
// Device detection: explicit requests fail loud when nothing is booted.
// ---------------------------------------------------------------------------

export async function iosBooted(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
      timeout: 15_000,
    });
    const parsed = JSON.parse(stdout) as { devices: Record<string, { state: string }[]> };
    return Object.values(parsed.devices).some((list) => list.some((d) => d.state === "Booted"));
  } catch {
    return false;
  }
}

export async function androidConnected(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(adbBin(), ["get-state"], { timeout: 15_000 });
    return stdout.trim() === "device";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Frame guards
// ---------------------------------------------------------------------------

async function fingerprint(png: Buffer): Promise<Buffer> {
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

// ---------------------------------------------------------------------------
// Per-platform primitives
// ---------------------------------------------------------------------------

async function iosOpen(bundleId: string, url: string): Promise<void> {
  // Terminate first, mirroring Android's force-stop: a cold start routes the
  // initial URL deterministically, while an openurl into a running app that
  // already shows the destination (or is mid-transition) is indistinguishable
  // from a swallowed link. Proven by probe: warm openurl raced and wedged;
  // terminate + openurl landed every time.
  await execFileAsync("xcrun", ["simctl", "terminate", "booted", bundleId], { timeout: 30_000 }).catch(
    () => {},
  );
  await sleep(800);
  await execFileAsync("xcrun", ["simctl", "openurl", "booted", url], { timeout: 30_000 });
}

async function iosShot(file: string): Promise<void> {
  await execFileAsync("xcrun", ["simctl", "io", "booted", "screenshot", file], { timeout: 30_000 });
}

async function androidOpen(bundleId: string, url: string): Promise<void> {
  // The force-stop is the load-bearing half; see the header comment.
  await execFileAsync(adbBin(), ["shell", "am", "force-stop", bundleId], { timeout: 30_000 });
  await execFileAsync(
    adbBin(),
    ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url],
    { timeout: 30_000 },
  );
}

async function androidShot(file: string): Promise<void> {
  const { stdout } = await execFileAsync(adbBin(), ["exec-out", "screencap", "-p"], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer" as BufferEncoding,
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, stdout);
}

async function warmup(platform: "ios" | "android", app: NativeAppConfig, progress: (l: string) => void): Promise<void> {
  progress(`${platform}: warming up ${app.bundleId} (18s)`);
  if (platform === "ios") {
    await execFileAsync("xcrun", ["simctl", "launch", "booted", app.bundleId], { timeout: 30_000 }).catch(() => {});
  } else {
    await execFileAsync(adbBin(), ["shell", "am", "force-stop", app.bundleId], { timeout: 30_000 }).catch(() => {});
    await execFileAsync(
      adbBin(),
      ["shell", "monkey", "-p", app.bundleId, "-c", "android.intent.category.LAUNCHER", "1"],
      { timeout: 30_000 },
    ).catch(() => {});
  }
  await sleep(18_000);
}

// ---------------------------------------------------------------------------
// The capture loop
// ---------------------------------------------------------------------------

export async function captureNative(
  resolved: ResolvedConfig,
  targets: ResolvedTarget[],
  opts: NativeCaptureOptions,
): Promise<NativeCaptureResult> {
  const progress = opts.onProgress ?? (() => {});
  const startedAt = nowIso();
  const failures: RunRecord["failures"] = [];
  const skips: RunRecord["skips"] = [];
  const shots: ShotRecord[] = [];

  const native = resolved.config.native;
  if (!native || (!native.ios && !native.android)) {
    throw new LookoutError(
      "this project declares no native apps",
      "add native: { ios: { deepLinkScheme, bundleId }, android: { ... } } to .lookout/config.ts",
    );
  }

  // One native app per project; its routes come from the first selected target.
  const target = targets[0]!;
  const evDir = evidenceDir(resolved);

  for (const platform of opts.platforms) {
    const app = native[platform];
    if (!app) {
      skips.push({ platform, reason: `no native.${platform} config` });
      continue;
    }
    const available = platform === "ios" ? await iosBooted() : await androidConnected();
    if (!available) {
      const fix =
        platform === "ios"
          ? "boot a simulator with the app installed (open -a Simulator)"
          : `start an emulator with the app installed (check \`${adbBin()} devices\`)`;
      throw new LookoutError(`${platform} capture requested but no device is available`, fix);
    }

    if (opts.schemes.length > 1 && !app.appearanceParam) {
      throw new LookoutError(
        `${platform}: capturing both schemes needs native.${platform}.appearanceParam`,
        "the app must read a scheme from the deep link (e.g. ?scheme=light); otherwise capture one scheme",
      );
    }

    await warmup(platform, app, progress);

    // Seed the stale-frame guard from whatever is on screen after warmup
    // (usually the app's home). Without the seed, the FIRST route's shot is
    // unchecked, and a deep link that raced the router banks the home screen
    // as if it were the requested page: the exact failure capture-looks
    // documented. With the seed, that frame reads as stale and retries.
    let lastFrame: Buffer | null = null;
    try {
      const seedPath = join(evDir, `.seed-${platform}.png`);
      await mkdir(dirname(seedPath), { recursive: true });
      if (platform === "ios") await iosShot(seedPath);
      else await androidShot(seedPath);
      const { readFile, rm } = await import("node:fs/promises");
      lastFrame = await fingerprint(await readFile(seedPath));
      await rm(seedPath, { force: true });
    } catch {
      // Seeding is best-effort; an unseeded first frame is the old behavior.
    }
    // Cold starts need room: the dev-client relaunch plus Metro's on-demand
    // route bundling runs 5-8s on first hit. Retries absorb the tail.
    const settleMs = app.settleMs ?? (platform === "ios" ? 7000 : 14_000);

    for (const scheme of opts.schemes) {
      for (const route of target.routes) {
        const axes: ShotAxes = {
          target: target.def.name,
          route: route.path,
          state: "rest",
          platform: platform as PlatformKind,
          formFactor: "phone",
          scheme,
        };
        try {
          const path = route.path.replace(/^\//, "");
          const url = new URL(`${app.deepLinkScheme}:///${path}`);
          if (app.appearanceParam) url.searchParams.set(app.appearanceParam, scheme);

          let png: Buffer | null = null;
          const findings: DeterministicFinding[] = [];
          for (let attempt = 1; attempt <= RETRIES; attempt++) {
            if (platform === "ios") await iosOpen(app.bundleId, url.toString());
            else await androidOpen(app.bundleId, url.toString());
            await sleep(settleMs);

            const abs = join(evDir, shotRelPath(axes));
            await mkdir(dirname(abs), { recursive: true });
            if (platform === "ios") await iosShot(abs);
            else await androidShot(abs);
            const { readFile } = await import("node:fs/promises");
            const candidate = await readFile(abs);

            if (candidate.byteLength < BLANK_BYTES) {
              progress(`${platform} ${route.path}: blank frame (${candidate.byteLength}b), retry ${attempt}/${RETRIES}`);
              await sleep(4000);
              continue;
            }
            const fp = await fingerprint(candidate);
            if (lastFrame && meanAbsDiff(fp, lastFrame) < STALE_MAD) {
              progress(`${platform} ${route.path}: stale frame, retry ${attempt}/${RETRIES}`);
              await sleep(4000);
              continue;
            }
            lastFrame = fp;
            png = candidate;
            break;
          }
          if (!png) {
            throw new Error(`no fresh painted frame after ${RETRIES} attempts`);
          }

          // Scheme read-back: an inconclusive read is informational; a
          // contradicting read is an error (mislabeled evidence poisons
          // every downstream judgment).
          const lum = await meanLuminance(png);
          const measured = schemeFromLuminance(lum);
          if (measured && measured !== scheme) {
            findings.push({
              type: "scheme-mismatch",
              severity: "error",
              message: `requested ${scheme} but the screen reads ${measured} (mean luminance ${lum.toFixed(0)})`,
            });
          }

          const sharp = (await import("sharp")).default;
          const meta = await sharp(png).metadata();
          shots.push({
            id: shotId(axes),
            target: target.def.name,
            route: route.path,
            routeName: route.name,
            state: "rest",
            platform: platform as PlatformKind,
            formFactor: "phone",
            scheme,
            path: shotRelPath(axes),
            hash: sha256(png),
            bytes: png.byteLength,
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            animated: false,
            capturedAt: nowIso(),
            runId: opts.runId,
            deterministicFindings: findings,
          });
          opts.onShot?.(shots[shots.length - 1]!);
          progress(`shot ${shotId(axes)}${findings.length ? ` (${findings.length} finding(s))` : ""}`);
        } catch (e) {
          failures.push({
            target: target.def.name,
            route: route.path,
            step: platform,
            message: (e as Error).message.slice(0, 500),
          });
          progress(`FAIL ${platform} ${route.path}: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }
  }

  return {
    run: {
      id: opts.runId,
      kind: "native",
      startedAt,
      finishedAt: nowIso(),
      flags: { platforms: opts.platforms, schemes: opts.schemes },
      failures,
      skips,
    },
    shots,
  };
}
