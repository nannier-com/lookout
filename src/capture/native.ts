/**
 * Native capture: iOS simulators and Android emulators, one device per kind.
 * Generic over any app that exposes a deep-link scheme; the per-project
 * config supplies deepLinkScheme, bundleId, and settle times.
 *
 * Every booted device of a platform is walked, one phone and one tablet at
 * most (a shot's identity has no room for two of a kind), addressed by its own
 * identifier, and a shot carries the device's kind as its form factor and the
 * device itself by name. The platform commands live in native-ios.ts and
 * native-android.ts; the device listing in native-device.ts; one photograph,
 * with its guards and its scheme read-back, in native-shot.ts.
 *
 * Schemes: an app that reads its scheme off the deep link declares
 * `appearanceParam` and the link carries it. One that follows the system
 * appearance gets the device switched before each scheme's routes, and the
 * read-back on every shot says whether the app followed.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LookoutError,
  type DeviceKind,
  type NativeAppConfig,
  type ResolvedConfig,
  type RunRecord,
  type Scheme,
  type ShotRecord,
} from "../types.js";
import type { ResolvedTarget } from "../targets.js";
import { evidenceDir } from "../config.js";
import { shotId, type ShotAxes } from "./store.js";
import { androidWarmup } from "./native-android.js";
import { iosWarmup } from "./native-ios.js";
import { bootedDevices, oneOfEachKind, type NativeDevice, type NativePlatform } from "./native-device.js";
import { deepLink, fingerprint, photographDevice, setDeviceAppearance, shootDevice } from "./native-shot.js";
import { nowIso, sha256, sleep } from "../util.js";

export { schemeFromLuminance } from "./native-shot.js";

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

/**
 * Warm the app up on a device and seed the stale-frame guard from whatever
 * is on screen afterwards (usually the app's home). Without the seed, the
 * FIRST route's shot is unchecked, and a deep link that raced the router
 * banks the home screen as if it were the requested page.
 */
export async function warmDevice(
  device: NativeDevice,
  app: NativeAppConfig,
  evDir: string,
  progress: (line: string) => void,
): Promise<Buffer | null> {
  progress(`${device.platform}: ${device.name} (${device.formFactor}): warming up ${app.bundleId} (18s)`);
  if (device.platform === "ios") await iosWarmup(device.id, app.bundleId);
  else await androidWarmup(device.id, app.bundleId);
  await sleep(18_000);
  try {
    const seedPath = join(evDir, `.seed-${device.platform}-${device.formFactor}.png`);
    await mkdir(dirname(seedPath), { recursive: true });
    await shootDevice(device, seedPath);
    const seed = await fingerprint(await readFile(seedPath));
    await rm(seedPath, { force: true });
    return seed;
  } catch {
    // Seeding is best-effort; an unseeded first frame is the old behavior.
    return null;
  }
}

/** The devices of one platform a run photographs, or the reason it cannot. */
export async function devicesFor(
  platform: NativePlatform,
  app: NativeAppConfig,
  progress: (line: string) => void,
  skips: RunRecord["skips"],
): Promise<NativeDevice[]> {
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
  return devices;
}

/** Cold starts need room: the dev-client relaunch plus Metro's on-demand route bundling runs 5-8s on first hit. */
export function deviceSettleMs(platform: NativePlatform, app: NativeAppConfig): number {
  return app.settleMs ?? (platform === "ios" ? 7000 : 14_000);
}

/**
 * Put the device in the scheme about to be photographed, when the app has
 * no deep-link parameter to carry it. A switch that fails is reported and
 * the shot is still taken: the read-back files the mismatch.
 */
export async function prepareScheme(
  device: NativeDevice,
  app: NativeAppConfig,
  scheme: Scheme,
  progress: (line: string) => void,
): Promise<void> {
  if (app.appearanceParam) return;
  try {
    await setDeviceAppearance(device, scheme);
  } catch (e) {
    progress(`${device.platform}: could not switch ${device.name} to ${scheme}: ${(e as Error).message.slice(0, 120)}`);
  }
}

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
    const devices = await devicesFor(platform, app, progress, skips);
    if (opts.schemes.length > 1 && !app.appearanceParam) {
      progress(`${platform}: no native.${platform}.appearanceParam; switching the device appearance per scheme`);
    }

    for (const device of devices) {
      let lastFrame = await warmDevice(device, app, evDir, progress);
      const settleMs = deviceSettleMs(platform, app);

      for (const scheme of opts.schemes) {
        await prepareScheme(device, app, scheme, progress);
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
            const url = deepLink(app, route.path, scheme);
            const shot = await photographDevice(device, app, axes, {
              scheme,
              url,
              settleMs,
              evidenceDir: evDir,
              lastFrame,
              progress,
            });
            lastFrame = shot.lastFrame;
            const sharp = (await import("sharp")).default;
            const meta = await sharp(shot.png).metadata();
            shots.push({
              id: shotId(axes),
              target: target.def.name,
              route: route.path,
              routeName: route.name,
              state: "rest",
              platform,
              formFactor: device.formFactor,
              scheme,
              path: shot.rel,
              hash: sha256(shot.png),
              bytes: shot.png.byteLength,
              width: meta.width ?? 0,
              height: meta.height ?? 0,
              animated: false,
              url,
              device: { id: device.id, name: device.name },
              capturedAt: nowIso(),
              runId: opts.runId,
              deterministicFindings: shot.findings,
            });
            opts.onShot?.(shots[shots.length - 1]!);
            progress(`shot ${shotId(axes)}${shot.findings.length ? ` (${shot.findings.length} finding(s))` : ""}`);
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
