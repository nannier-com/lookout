/**
 * The devices a native capture can address: which simulators and emulators
 * are booted, what kind each one is, and whether the app is on it.
 *
 * "booted" used to be the whole answer, and `simctl` accepts the word as a
 * device: whichever booted device it picked got the deep link and the
 * screenshot, and every shot was labelled a phone. An iPad beside an iPhone
 * was unreachable, and an iPad alone was a phone in the record. So a device
 * is addressed by its own identifier, its kind is read off what the tools
 * report (an iPad, or Android's `ro.build.characteristics`), and the kind is
 * the shot's form factor.
 *
 * Parsing is kept apart from running the tools so it can be tested on canned
 * output on a machine with neither Xcode nor an Android SDK.
 */
import { execFileAsync } from "../util.js";
import type { DeviceKind, PlatformKind } from "../types.js";

export type NativePlatform = Exclude<PlatformKind, "web">;

export interface NativeDevice {
  platform: NativePlatform;
  /** The simulator udid, or the emulator's adb serial: what every command is addressed to. */
  id: string;
  /** What a person calls it: "iPhone 17", "Pixel Tablet". */
  name: string;
  formFactor: DeviceKind;
}

export function adbBin(): string {
  return process.env.ADB ?? "adb";
}

/** Every booted simulator in `xcrun simctl list devices booted -j`, iPads as tablets. */
export function devicesOfSimctl(json: string): NativeDevice[] {
  let parsed: { devices?: Record<string, { state?: string; udid?: string; name?: string; deviceTypeIdentifier?: string }[]> };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return [];
  }
  const out: NativeDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    // Only iOS runtimes: a booted Apple Watch or Apple TV is not a phone.
    if (!/iOS/i.test(runtime)) continue;
    for (const d of list) {
      if (d.state !== "Booted" || typeof d.udid !== "string") continue;
      const kindHint = `${d.deviceTypeIdentifier ?? ""} ${d.name ?? ""}`;
      out.push({
        platform: "ios",
        id: d.udid,
        name: d.name ?? d.udid,
        formFactor: /iPad/i.test(kindHint) ? "tablet" : "phone",
      });
    }
  }
  return out;
}

/** The serials `adb devices -l` reports as ready; offline and unauthorized ones are not devices yet. */
export function serialsOfAdb(output: string): string[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === "device")
    .map((cols) => cols[0]!);
}

/** An Android device from what `getprop` says about it: a tablet when the build says so. */
export function deviceOfAndroid(serial: string, model: string, characteristics: string): NativeDevice {
  const tablet = characteristics
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .includes("tablet");
  return { platform: "android", id: serial, name: model.trim() || serial, formFactor: tablet ? "tablet" : "phone" };
}

/** The booted devices of one platform, or none when the tools are absent or nothing is booted. */
export async function bootedDevices(platform: NativePlatform): Promise<NativeDevice[]> {
  try {
    if (platform === "ios") {
      const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { timeout: 15_000 });
      return devicesOfSimctl(stdout);
    }
    const { stdout } = await execFileAsync(adbBin(), ["devices", "-l"], { timeout: 15_000 });
    const devices: NativeDevice[] = [];
    for (const serial of serialsOfAdb(stdout)) {
      const prop = async (name: string): Promise<string> =>
        (await execFileAsync(adbBin(), ["-s", serial, "shell", "getprop", name], { timeout: 15_000 })).stdout;
      devices.push(deviceOfAndroid(serial, await prop("ro.product.model"), await prop("ro.build.characteristics")));
    }
    return devices;
  } catch {
    return [];
  }
}

/** Whether the app is installed on the device, asked the way the platform answers it. */
export async function appInstalled(device: NativeDevice, bundleId: string): Promise<boolean> {
  try {
    if (device.platform === "ios") {
      await execFileAsync("xcrun", ["simctl", "get_app_container", device.id, bundleId], { timeout: 15_000 });
      return true;
    }
    const { stdout } = await execFileAsync(adbBin(), ["-s", device.id, "shell", "pm", "path", bundleId], { timeout: 15_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * One device per kind, in kind order: a run addresses one phone and one
 * tablet, because a shot's identity has no room for two of a kind, and
 * `chosen` says which was taken when several of one kind are booted.
 */
export function oneOfEachKind(devices: readonly NativeDevice[]): NativeDevice[] {
  const chosen: NativeDevice[] = [];
  for (const kind of ["phone", "tablet"] as const) {
    const first = devices.find((d) => d.formFactor === kind);
    if (first) chosen.push(first);
  }
  return chosen;
}
