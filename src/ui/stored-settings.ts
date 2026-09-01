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
import { lookoutHome } from "../home.js";

export interface UiSettings {
  /** Project root holding the lookout.config.ts to drive. */
  projectDir: string | null;
  /**
   * Where the app actually is, when it is not where the config says.
   *
   * Overrides the origin of every target while keeping the config's routes,
   * recipes and sign-in hook, which is the difference between this and the
   * zero-config `--url`.
   */
  baseUrl: string | null;
  /**
   * The project directory whose calls to action may be clicked, or null.
   *
   * Consent is stored WITH the directory it was given for rather than as a
   * bare boolean, so pointing the page at a second project does not carry the
   * first one's yes across. Navigation discovery actuates what it plans,
   * destructive controls included, and that is a promise about one repository
   * on one dev stack, not a preference about the reader.
   */
  navigationFor: string | null;
}

export const EMPTY_SETTINGS: UiSettings = { projectDir: null, baseUrl: null, navigationFor: null };

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
      navigationFor:
        typeof raw.navigationFor === "string" && raw.navigationFor.trim() ? raw.navigationFor.trim() : null,
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

/**
 * Whether this project's calls to action may be clicked on the next run.
 *
 * One function because two places ask: the settings view the page paints its
 * toggle from, and the spawn that decides whether to pass --navigation. Two
 * spellings of the same comparison is how a page comes to show a control that
 * is on while the run it starts is off.
 */
export function navigationConsented(s: UiSettings, projectDir: string | null): boolean {
  return !!projectDir && s.navigationFor === projectDir;
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
