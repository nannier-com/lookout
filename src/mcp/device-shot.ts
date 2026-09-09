/**
 * Photographing a device screen the navigator reached, as it is: no cold
 * start, because a cold start would lose the screen. The blank guard and
 * the scheme read-back are the capture's own; the stale-frame guard is not
 * applied, because the screen is meant to be the one that was there.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NativeDevice } from "../capture/native-device.js";
import { deepLink, schemeFromLuminance, setDeviceAppearance, shootDevice } from "../capture/native-shot.js";
import { shotId, shotRelPath, type ShotAxes } from "../capture/store.js";
import type { DeterministicFinding, NativeAppConfig, Scheme, ShotRecord } from "../types.js";
import { nowIso, sha256, sleep } from "../util.js";

const BLANK_BYTES = 60_000;

async function meanLuminance(png: Buffer): Promise<number> {
  const sharp = (await import("sharp")).default;
  const stats = await sharp(png).grayscale().stats();
  return stats.channels[0]?.mean ?? 128;
}

/** One photograph of the screen as it stands, checked for blankness and for the scheme it shows. */
export async function photographCurrent(
  device: NativeDevice,
  axes: ShotAxes,
  opts: { evidenceDir: string; scheme: Scheme },
): Promise<{ png: Buffer; rel: string; findings: DeterministicFinding[] }> {
  const rel = shotRelPath(axes);
  const abs = join(opts.evidenceDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await shootDevice(device, abs);
  const png = await readFile(abs);
  const findings: DeterministicFinding[] = [];
  if (png.byteLength < BLANK_BYTES) {
    findings.push({ type: "blank-shot", severity: "error", message: `the screen photographed blank (${png.byteLength} bytes)` });
  }
  const lum = await meanLuminance(png);
  const measured = schemeFromLuminance(lum);
  if (measured && measured !== opts.scheme) {
    findings.push({
      type: "scheme-mismatch",
      severity: "error",
      message: `requested ${opts.scheme} but the screen reads ${measured} (mean luminance ${lum.toFixed(0)})`,
    });
  }
  return { png, rel, findings };
}

/** The shot record for a device photograph, the way the native capture writes one. */
export async function deviceRecord(args: {
  device: NativeDevice;
  app: NativeAppConfig;
  axes: ShotAxes;
  png: Buffer;
  rel: string;
  findings: DeterministicFinding[];
  runId: string;
  routeName: string;
  description?: string;
}): Promise<ShotRecord> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(args.png).metadata();
  return {
    id: shotId(args.axes),
    target: args.axes.target,
    route: args.axes.route,
    routeName: args.routeName,
    state: args.axes.state,
    platform: args.axes.platform,
    formFactor: args.axes.formFactor,
    scheme: args.axes.scheme,
    path: args.rel,
    hash: sha256(args.png),
    bytes: args.png.byteLength,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    animated: false,
    url: deepLink(args.app, args.axes.route, args.axes.scheme),
    device: { id: args.device.id, name: args.device.name },
    ...(args.description ? { stateDescription: args.description } : {}),
    capturedAt: nowIso(),
    runId: args.runId,
    deterministicFindings: args.findings,
  };
}

/**
 * Photograph the screen in every scheme the session asked for. The device is
 * switched between them when the app follows the system appearance; an app
 * that reads the scheme off its deep link shows whichever it was opened in,
 * and the read-back says so.
 */
export async function photographSchemes(args: {
  device: NativeDevice;
  app: NativeAppConfig;
  axes: Omit<ShotAxes, "scheme">;
  schemes: readonly Scheme[];
  evidenceDir: string;
  runId: string;
  routeName: string;
  description?: string;
  settleMs: number;
  progress: (line: string) => void;
}): Promise<{ shots: ShotRecord[]; failures: { step: string; message: string }[] }> {
  const shots: ShotRecord[] = [];
  const failures: { step: string; message: string }[] = [];
  for (const [i, scheme] of args.schemes.entries()) {
    const axes: ShotAxes = { ...args.axes, scheme };
    try {
      if (i > 0 && !args.app.appearanceParam) {
        await setDeviceAppearance(args.device, scheme).catch((e: Error) => args.progress(`could not switch ${args.device.name} to ${scheme}: ${e.message.slice(0, 120)}`));
        await sleep(args.settleMs);
      }
      const shot = await photographCurrent(args.device, axes, { evidenceDir: args.evidenceDir, scheme });
      shots.push(await deviceRecord({ ...args, axes, ...shot }));
      args.progress(`shot ${shotId(axes)}${shot.findings.length ? ` (${shot.findings.length} finding(s))` : ""}`);
    } catch (e) {
      failures.push({ step: `${args.device.platform} ${args.device.formFactor} ${scheme}`, message: (e as Error).message.slice(0, 500) });
      args.progress(`FAIL ${shotId(axes)}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { shots, failures };
}
