/**
 * Native capture: iOS simulators and Android emulators, one device per kind.
 * Generic over any app that exposes a deep-link scheme; the per-project
 * config supplies deepLinkScheme, bundleId, and settle times.
 *
 * Every booted device of a platform is walked, one phone and one tablet at
 * most (a shot's identity has no room for two of a kind), addressed by its own
 * identifier, and a shot carries the device's kind as its form factor and the
 * device itself by name. The platform commands live in native-ios.ts and
 * native-android.ts; the device listing in native-device.ts.
 *
 * Recipes learned the hard way:
 * - Blank guard: a painted screen is hundreds of KB of PNG; a splash is tiny.
 * - Stale-frame guard: grayscale-downsample each grab and compare against the
 *   last accepted frame on that device; near-identical means the app is still
 *   showing the previous route.
 * - Scheme read-back: mean luminance decides whether a shot is actually dark
 *   or light; a shot contradicting its label is an error, never a silent lie.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LookoutError,
  type DeterministicFinding,
  type DeviceKind,
  type NativeAppConfig,
  type ResolvedConfig,
  type RunRecord,
  type Scheme,
  type ShotRecord,
} from "../types.js";
import type { ResolvedTarget } from "../targets.js";
import { evidenceDir } from "../config.js";
import { shotId, shotRelPath, type ShotAxes } from "./store.js";
import { androidOpen, androidShot, androidWarmup } from "./native-android.js";
import { iosOpen, iosShot, iosWarmup } from "./native-ios.js";
import { bootedDevices, oneOfEachKind, type NativeDevice, type NativePlatform } from "./native-device.js";
import { nowIso, sha256, sleep } from "../util.js";

const BLANK_BYTES = 60_000;
const STALE_MAD = 4;
const RETRIES = 4;

export interface NativeCaptureOptions {
  platforms: NativePlatform[];
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

/** What the operator is told when a platform has no device with the app. */
export function deviceHint(platform: NativePlatform, app: NativeAppConfig): string {
  if (app.startHint) return app.startHint;
  return platform === "ios"
    ? "boot a simulator with the app installed (open -a Simulator)"
    : "start an emulator with the app installed (check `adb devices`)";
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

async function open(device: NativeDevice, bundleId: string, url: string): Promise<void> {
  if (device.platform === "ios") await iosOpen(device.id, bundleId, url);
  else await androidOpen(device.id, bundleId, url);
}

async function shoot(device: NativeDevice, file: string): Promise<void> {
  if (device.platform === "ios") await iosShot(device.id, file);
  else await androidShot(device.id, file);
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
      "add native: { ios: { deepLinkScheme, bundleId }, android: { ... } } to lookout.config.ts",
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
    const booted = await bootedDevices(platform);
    const devices = oneOfEachKind(booted);
    if (devices.length === 0) {
      throw new LookoutError(`${platform} capture requested but no device is booted`, deviceHint(platform, app));
    }
    // A kind the run wanted and could not have: said, so the tally can say it
    // too, rather than silently a phone-only run.
    for (const kind of ["phone", "tablet"] as const satisfies readonly DeviceKind[]) {
      if (!devices.some((d) => d.formFactor === kind)) {
        skips.push({ platform, reason: `no booted ${kind}${(app.devices ?? ["phone"]).includes(kind) ? " (required)" : ""}` });
      }
    }
    if (booted.length > devices.length) {
      progress(`${platform}: ${booted.length} devices booted, capturing ${devices.map((d) => `${d.name} (${d.formFactor})`).join(" and ")}`);
    }

    if (opts.schemes.length > 1 && !app.appearanceParam) {
      throw new LookoutError(
        `${platform}: capturing both schemes needs native.${platform}.appearanceParam`,
        "the app must read a scheme from the deep link (e.g. ?scheme=light); otherwise capture one scheme",
      );
    }

    for (const device of devices) {
      progress(`${platform}: ${device.name} (${device.formFactor}): warming up ${app.bundleId} (18s)`);
      if (platform === "ios") await iosWarmup(device.id, app.bundleId);
      else await androidWarmup(device.id, app.bundleId);
      await sleep(18_000);

      // Seed the stale-frame guard from whatever is on screen after warmup
      // (usually the app's home). Without the seed, the FIRST route's shot is
      // unchecked, and a deep link that raced the router banks the home screen
      // as if it were the requested page.
      let lastFrame: Buffer | null = null;
      try {
        const seedPath = join(evDir, `.seed-${platform}-${device.formFactor}.png`);
        await mkdir(dirname(seedPath), { recursive: true });
        await shoot(device, seedPath);
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
            platform,
            formFactor: device.formFactor,
            scheme,
          };
          try {
            const path = route.path.replace(/^\//, "");
            const url = new URL(`${app.deepLinkScheme}:///${path}`);
            if (app.appearanceParam) url.searchParams.set(app.appearanceParam, scheme);

            let png: Buffer | null = null;
            const findings: DeterministicFinding[] = [];
            for (let attempt = 1; attempt <= RETRIES; attempt++) {
              await open(device, app.bundleId, url.toString());
              await sleep(settleMs);

              const abs = join(evDir, shotRelPath(axes));
              await mkdir(dirname(abs), { recursive: true });
              await shoot(device, abs);
              const candidate = await readFile(abs);

              if (candidate.byteLength < BLANK_BYTES) {
                progress(`${platform} ${device.formFactor} ${route.path}: blank frame (${candidate.byteLength}b), retry ${attempt}/${RETRIES}`);
                await sleep(4000);
                continue;
              }
              const fp = await fingerprint(candidate);
              if (lastFrame && meanAbsDiff(fp, lastFrame) < STALE_MAD) {
                progress(`${platform} ${device.formFactor} ${route.path}: stale frame, retry ${attempt}/${RETRIES}`);
                await sleep(4000);
                continue;
              }
              lastFrame = fp;
              png = candidate;
              break;
            }
            if (!png) throw new Error(`no fresh painted frame after ${RETRIES} attempts`);

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
              platform,
              formFactor: device.formFactor,
              scheme,
              path: shotRelPath(axes),
              hash: sha256(png),
              bytes: png.byteLength,
              width: meta.width ?? 0,
              height: meta.height ?? 0,
              animated: false,
              url: url.toString(),
              device: { id: device.id, name: device.name },
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
              step: `${platform} ${device.formFactor}`,
              message: (e as Error).message.slice(0, 500),
            });
            progress(`FAIL ${platform} ${device.formFactor} ${route.path}: ${(e as Error).message.slice(0, 200)}`);
          }
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
