/**
 * The commands that act on a simulator or an emulator, as argument lists.
 * Pure builders, so a test can read what would run; `runDevice` is the one
 * place they are executed.
 *
 * iOS: `xcrun simctl` opens, photographs and switches appearance, and cannot
 * tap. Taps, swipes, text and keys go through `idb` (Meta's simulator
 * driver), which is optional; without it every one of those tools says so
 * and what to install. Android: `adb` does all of it.
 */
import { adbBin, type NativeDevice } from "../capture/native-device.js";
import { execFileAsync, have } from "../util.js";
import { ToolRefusal } from "./driver.js";

export interface DeviceCommand {
  bin: string;
  args: string[];
}

export function idbBin(): string {
  return process.env.LOOKOUT_IDB_BIN ?? "idb";
}

export async function idbAvailable(): Promise<boolean> {
  const bin = idbBin();
  return bin.includes("/") ? true : have(bin);
}

export const IDB_HINT = "tapping a simulator needs idb on this machine: brew install idb-companion; pip install fb-idb";

/** Refuse an iOS action that needs idb when it is not here, naming the fix. */
export async function requireIdb(what: string): Promise<void> {
  if (!(await idbAvailable())) throw new ToolRefusal(`${what} needs idb; ${IDB_HINT}`);
}

export function tapCommand(device: NativeDevice, x: number, y: number): DeviceCommand {
  return device.platform === "ios"
    ? { bin: idbBin(), args: ["ui", "tap", String(Math.round(x)), String(Math.round(y)), "--udid", device.id] }
    : { bin: adbBin(), args: ["-s", device.id, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))] };
}

export function swipeCommand(
  device: NativeDevice,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
): DeviceCommand {
  const r = (n: number): string => String(Math.round(n));
  return device.platform === "ios"
    ? { bin: idbBin(), args: ["ui", "swipe", r(from.x), r(from.y), r(to.x), r(to.y), "--duration", String(Math.max(0.05, durationMs / 1000)), "--udid", device.id] }
    : { bin: adbBin(), args: ["-s", device.id, "shell", "input", "swipe", r(from.x), r(from.y), r(to.x), r(to.y), String(Math.max(1, Math.round(durationMs)))] };
}

export function textCommand(device: NativeDevice, text: string): DeviceCommand {
  return device.platform === "ios"
    ? { bin: idbBin(), args: ["ui", "text", text, "--udid", device.id] }
    : // adb's input text takes no spaces; %s is the space it understands.
      { bin: adbBin(), args: ["-s", device.id, "shell", "input", "text", text.replace(/ /g, "%s")] };
}

export function keyCommand(device: NativeDevice, code: string | number): DeviceCommand {
  return device.platform === "ios"
    ? { bin: idbBin(), args: ["ui", "key", String(code), "--udid", device.id] }
    : { bin: adbBin(), args: ["-s", device.id, "shell", "input", "keyevent", String(code)] };
}

/** The screen's own description of itself: what `snapshot` parses. */
export function describeCommand(device: NativeDevice): DeviceCommand {
  return device.platform === "ios"
    ? { bin: idbBin(), args: ["ui", "describe-all", "--json", "--udid", device.id] }
    : { bin: adbBin(), args: ["-s", device.id, "exec-out", "uiautomator", "dump", "/dev/tty"] };
}

export async function runDevice(cmd: DeviceCommand, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(cmd.bin, cmd.args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
