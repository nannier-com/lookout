/**
 * The Android emulator (or a connected device), addressed by adb serial.
 * Recipes learned the hard way, kept with the commands they explain.
 */
import { writeFile } from "node:fs/promises";
import { execFileAsync } from "../util.js";
import { adbBin } from "./native-device.js";

export async function androidOpen(serial: string, bundleId: string, url: string): Promise<void> {
  // The force-stop is the load-bearing half: an intent delivered to a running
  // activity is swallowed and the router never moves, banking a screenshot of
  // the previous page. No retry fixes it; only the force-stop.
  await execFileAsync(adbBin(), ["-s", serial, "shell", "am", "force-stop", bundleId], { timeout: 30_000 });
  await execFileAsync(
    adbBin(),
    ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url],
    { timeout: 30_000 },
  );
}

export async function androidShot(serial: string, file: string): Promise<void> {
  const { stdout } = await execFileAsync(adbBin(), ["-s", serial, "exec-out", "screencap", "-p"], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer" as BufferEncoding,
  });
  await writeFile(file, stdout);
}

export async function androidWarmup(serial: string, bundleId: string): Promise<void> {
  await execFileAsync(adbBin(), ["-s", serial, "shell", "am", "force-stop", bundleId], { timeout: 30_000 }).catch(() => {});
  await execFileAsync(
    adbBin(),
    ["-s", serial, "shell", "monkey", "-p", bundleId, "-c", "android.intent.category.LAUNCHER", "1"],
    { timeout: 30_000 },
  ).catch(() => {});
}
