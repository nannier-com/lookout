/**
 * What the ui page has been pointed at, remembered between runs.
 *
 * The page used to ask for a folder every time it wanted to start a run, in the
 * middle of the click that was meant to start it, and forgot the answer the
 * moment the server stopped. Configuring where lookout looks is a separate act
 * from running it, and the answer is worth keeping, so it lives here rather
 * than in the run.
 *
 * Stored under the lookout home (shared with incidents), not in any project:
 * it describes which project the viewer is looking at, so it cannot live inside
 * one of them.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lookoutHome } from "../skills/incidents.js";

export interface UiSettings {
  /** Project root holding the .lookout/config.ts to drive. */
  projectDir: string | null;
  /**
   * Where the app actually is, when it is not where the config says.
   *
   * Overrides the origin of every target while keeping the config's routes,
   * recipes and sign-in hook, which is the difference between this and the
   * zero-config `--url`.
   */
  baseUrl: string | null;
}

export const EMPTY_SETTINGS: UiSettings = { projectDir: null, baseUrl: null };

export function settingsPath(): string {
  return join(lookoutHome(), "ui.json");
}

export async function loadSettings(): Promise<UiSettings> {
  const p = settingsPath();
  if (!existsSync(p)) return { ...EMPTY_SETTINGS };
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as Partial<UiSettings>;
    return {
      projectDir: typeof raw.projectDir === "string" ? raw.projectDir : null,
      baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : null,
    };
  } catch {
    // Unreadable settings are not worth failing to start over; the page will
    // simply ask again.
    return { ...EMPTY_SETTINGS };
  }
}

export async function saveSettings(s: UiSettings): Promise<void> {
  const p = settingsPath();
  await mkdir(lookoutHome(), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, p);
}

/** A base URL is only usable if it parses and names a host. */
export function validBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}
