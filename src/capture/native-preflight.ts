/**
 * Whether the device fold can run: the devices a platform needs, booted and
 * carrying the app. The device-fold twin of the HTTP probe in targets.ts,
 * and like it, it never starts anything: a missing device is reported with
 * the project's own instruction for getting one.
 */
import { appInstalled, bootedDevices, oneOfEachKind, type NativeDevice, type NativePlatform } from "./native-device.js";
import { deviceHint } from "./native.js";
import type { DeviceKind, LookoutConfig } from "../types.js";

export interface DeviceStatus {
  platform: NativePlatform;
  /** The kinds the config requires (default phone). */
  required: DeviceKind[];
  /** One device per kind, booted right now. */
  booted: NativeDevice[];
  /** Required kinds with no booted device. */
  missing: DeviceKind[];
  /** Booted devices without the app installed. */
  appMissing: NativeDevice[];
  /** The config's own instruction, or the platform's generic one. */
  hint: string;
  /** No native block for this platform at all. */
  unconfigured: boolean;
}

/** Probe each native platform a run walks. Never boots or installs anything. */
export async function preflightDevices(config: LookoutConfig, platforms: readonly NativePlatform[]): Promise<DeviceStatus[]> {
  const out: DeviceStatus[] = [];
  for (const platform of platforms) {
    const app = config.native?.[platform];
    if (!app) {
      out.push({ platform, required: [], booted: [], missing: [], appMissing: [], hint: `add native.${platform} to lookout.config.ts`, unconfigured: true });
      continue;
    }
    const required = app.devices ?? ["phone"];
    const booted = oneOfEachKind(await bootedDevices(platform));
    const appMissing: NativeDevice[] = [];
    for (const device of booted) {
      if (!(await appInstalled(device, app.bundleId))) appMissing.push(device);
    }
    out.push({
      platform,
      required,
      booted,
      missing: required.filter((kind) => !booted.some((d) => d.formFactor === kind)),
      appMissing,
      hint: deviceHint(platform, app),
      unconfigured: false,
    });
  }
  return out;
}

/** Why the device fold cannot run, or null when every required device is there with the app. */
export function deviceDownReason(statuses: readonly DeviceStatus[]): string | null {
  const lines: string[] = [];
  for (const s of statuses) {
    if (s.unconfigured) {
      lines.push(`  ${s.platform}: no native.${s.platform} block in the config\n    ${s.hint}`);
      continue;
    }
    for (const kind of s.missing) lines.push(`  ${s.platform}: no ${kind} is booted (the config requires one)\n    ${s.hint}`);
    for (const d of s.appMissing) lines.push(`  ${s.platform}: ${d.name} (${d.formFactor}) is booted but does not have the app installed\n    ${s.hint}`);
  }
  return lines.length > 0 ? `device(s) not ready:\n${lines.join("\n")}` : null;
}

/** One line per device for a person: what is booted and whether it can be photographed. */
export function deviceLines(statuses: readonly DeviceStatus[]): string[] {
  const lines: string[] = [];
  for (const s of statuses) {
    if (s.unconfigured) {
      lines.push(`${s.platform}: not configured`);
      continue;
    }
    if (s.booted.length === 0) lines.push(`${s.platform}: no device booted (requires ${s.required.join(", ")})`);
    for (const d of s.booted) {
      const ok = !s.appMissing.includes(d);
      lines.push(`${s.platform}: ${d.name} (${d.formFactor}) ${ok ? "up, app installed" : "DOWN, app not installed"}`);
    }
    for (const kind of s.missing) if (s.booted.length > 0) lines.push(`${s.platform}: no ${kind} booted (required)`);
  }
  return lines;
}
