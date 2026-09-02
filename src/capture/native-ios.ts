/**
 * The iOS simulator, addressed by udid. Recipes learned the hard way, kept
 * with the commands they explain.
 */
import { execFileAsync, sleep } from "../util.js";

export async function iosOpen(udid: string, bundleId: string, url: string): Promise<void> {
  // Terminate first, mirroring Android's force-stop: a cold start routes the
  // initial URL deterministically, while an openurl into a running app that
  // already shows the destination (or is mid-transition) is indistinguishable
  // from a swallowed link. Proven by probe: warm openurl raced and wedged;
  // terminate + openurl landed every time.
  await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId], { timeout: 30_000 }).catch(() => {});
  await sleep(800);
  await execFileAsync("xcrun", ["simctl", "openurl", udid, url], { timeout: 30_000 });
}

export async function iosShot(udid: string, file: string): Promise<void> {
  await execFileAsync("xcrun", ["simctl", "io", udid, "screenshot", file], { timeout: 30_000 });
}

export async function iosWarmup(udid: string, bundleId: string): Promise<void> {
  await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId], { timeout: 30_000 }).catch(() => {});
}
