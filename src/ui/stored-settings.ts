/**
 * What the ui page has been pointed at, remembered between runs.
 *
 * The page used to ask for a folder every time it wanted to start a run, in the
 * middle of the click that was meant to start it, and forgot the answer the
 * moment the server stopped. Configuring where lookout looks is a separate act
 * from running it, and the answer is worth keeping, so it lives here rather
 * than in the run.
 *
 * Stored in `<project>/.lookout/ui.json`, never in the operator's home. Two
 * different projects can be named by one server, and the file each question
 * belongs in is decided by which one it is about:
 *
 *   baseUrl, navigationFor   the SERVED project's own file: they describe that
 *                            app and that repository, and mean nothing anywhere
 *                            else.
 *   projectDir               the LAUNCH directory's file: it names which project
 *                            a server started here should serve. A pointer still
 *                            cannot live inside the thing it points to, which is
 *                            what sent this file to the operator's home once;
 *                            keeping it beside the directory lookout was STARTED
 *                            in, rather than the one it ends up serving, is what
 *                            lets it be remembered without a machine-wide home.
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
  /**
   * The project a server started in THIS directory should serve, or null to
   * serve this directory itself.
   *
   * Written when somebody points the settings panel somewhere else, and read
   * at startup, which is what makes the choice survive a restart: `lookout ui`
   * still resolves the directory it was launched in the way every verb does,
   * and then asks that directory where it was last told to look.
   */
  projectDir: string | null;
  /**
   * Which model each AI judges this project with, keyed by its tool key.
   *
   * Per project rather than per browser, unlike the tool selector, because it
   * is not a preference about the reader: the ledger caches a verdict against
   * the model that gave it, so judging this project with a different model is a
   * different body of evidence about this repository. An absent key means
   * lookout's own default, which the settings panel reports rather than
   * guessing at.
   */
  judgeModels: Record<string, string>;
}

export const EMPTY_SETTINGS: UiSettings = {
  baseUrl: null,
  navigationFor: null,
  projectDir: null,
  judgeModels: {},
};

/**
 * A model name that can be handed to a CLI as an argument.
 *
 * The value reaches a spawn as the word after `--model`, so the one thing it
 * must not be able to do is arrive as a flag of its own: a leading dash would
 * let a stored setting turn into an option nobody typed. Everything real is
 * letters, digits and the three separators the vendors' names use, which is
 * narrow enough to say no to the rest without a list of models that goes stale.
 */
export function validModel(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed) ? trimmed : null;
}

/**
 * The stored models, keeping only what could still be passed to a CLI.
 *
 * A file somebody edited by hand is the normal case here, not the exceptional
 * one: `.lookout/ui.json` is plain JSON sitting in their repository. One bad
 * entry costs that entry rather than the whole panel.
 */
function models(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const clean = validModel(value);
    if (clean) out[key] = clean;
  }
  return out;
}

export function settingsPath(projectDir: string): string {
  return join(projectDir, LOOKOUT_DIR, "ui.json");
}

export async function loadSettings(projectDir: string): Promise<UiSettings> {
  const p = settingsPath(projectDir);
  if (!existsSync(p)) return { ...EMPTY_SETTINGS };
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as Partial<UiSettings>;
    return {
      baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : null,
      navigationFor:
        typeof raw.navigationFor === "string" && raw.navigationFor.trim() ? raw.navigationFor.trim() : null,
      projectDir:
        typeof raw.projectDir === "string" && raw.projectDir.trim() ? raw.projectDir.trim() : null,
      judgeModels: models(raw.judgeModels),
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
 * Write down which project a server launched HERE should serve.
 *
 * Read-modify-write rather than a save of what the session is holding: the
 * session's settings belong to the project being served, and this file belongs
 * to the directory the server was started in. Once those are two different
 * places, saving one over the other is how a base URL ends up in a repository
 * that never had one.
 */
export async function rememberProject(launchDir: string, projectDir: string | null): Promise<void> {
  const stored = await loadSettings(launchDir);
  await saveSettings(launchDir, { ...stored, projectDir });
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
