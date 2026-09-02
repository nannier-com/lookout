/**
 * What the ui page has been pointed at, remembered between runs.
 *
 * The page used to ask for a folder every time it wanted to start a run, in the
 * middle of the click that was meant to start it, and forgot the answer the
 * moment the server stopped. Configuring where lookout looks is a separate act
 * from running it, and the answer is worth keeping, so it lives here rather
 * than in the run.
 *
 * Stored in the project it describes, `<project>/.lookout/ui.json`. It used to
 * live in the operator's home because it named which project the page was
 * pointed at, and a pointer cannot live inside the thing it points to. The
 * page is not pointed any more: `lookout ui` serves the project it was started
 * in, the way every other verb does, so what is left to remember is that
 * project's own base URL and its calls-to-action consent.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOOKOUT_DIR } from "../config-locate.js";

export interface UiSettings {
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
   * Still the directory rather than a bare boolean, even though the file now
   * lives inside that directory: `.lookout/` gets copied, and worktree tooling
   * copies it wholesale. A `true` would carry one checkout's yes into another,
   * and navigation discovery actuates what it plans, destructive controls
   * included. That is a promise about one repository on one dev stack, not a
   * preference about the reader.
   */
  navigationFor: string | null;
}

export const EMPTY_SETTINGS: UiSettings = { baseUrl: null, navigationFor: null };

export function settingsPath(projectDir: string): string {
  return join(projectDir, LOOKOUT_DIR, "ui.json");
}

export async function loadSettings(projectDir: string): Promise<UiSettings> {
  const p = settingsPath(projectDir);
  if (!existsSync(p)) return { ...EMPTY_SETTINGS };
  try {
    // `projectDir` is deliberately not read back: a file written by an older
    // lookout carries one, and it named the project the page was pointed at,
    // which is a question this file no longer answers.
    const raw = JSON.parse(await readFile(p, "utf8")) as Partial<UiSettings>;
    return {
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

export async function saveSettings(projectDir: string, s: UiSettings): Promise<void> {
  const p = settingsPath(projectDir);
  await mkdir(join(projectDir, LOOKOUT_DIR), { recursive: true });
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
