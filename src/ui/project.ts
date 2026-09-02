/**
 * What the settings panel shows, and the one change it can make.
 *
 * The page used to choose the project too, with a native folder picker and a
 * remembered answer; `lookout ui` serves the directory it was started in now,
 * so what is left here is the base URL, which re-resolves the config, and the
 * probe. The probe is what makes the panel worth opening: "which targets
 * answer right now" shows a wrong port before a run is spent on it.
 */
import { loadConfig } from "../config.js";
import { preflight, resolveTargets } from "../targets.js";
import { deviceLines, preflightDevices } from "../capture/native-preflight.js";
import { detectProjectKind } from "../project-kind.js";
import { currentProjectOrNull, session, setCurrentProject } from "./session.js";
import { forgetNarration } from "./narration.js";
import { forgetBoard } from "./payload.js";
import { navigationConsented } from "./stored-settings.js";

/** What the settings panel shows: where lookout is pointed, and what answers. */
export interface SettingsView {
  projectDir: string | null;
  baseUrl: string | null;
  configPath: string | null;
  project: string | null;
  configured: boolean;
  /**
   * Whether this project's calls to action may be clicked on the next run.
   *
   * Resolved here rather than handed over raw, because what is stored is the
   * directory consent was given for: the page should not have to compare two
   * paths to know whether the consent under the cog is on.
   */
  navigation: boolean;
  targets: { name: string; url: string; routes: number; up: boolean; status: number | null }[];
  /**
   * The device fold, one line per booted device or per gap, in the words
   * `lookout targets` prints. Empty for a project judged in the web fold only.
   */
  devices: { line: string; up: boolean }[];
  error: string | null;
}

/**
 * Re-resolve this server's project with the base URL the panel just saved.
 *
 * The whole config is loaded again rather than the origin patched in, because
 * a target's URL is what preflight probes and what a run is spawned against,
 * and two spellings of "where the app is" is how a panel comes to report on
 * one origin while Play checks another.
 */
export async function applyBaseUrl(): Promise<void> {
  const current = currentProjectOrNull();
  if (!current?.configPath) return;
  try {
    setCurrentProject(
      await loadConfig({
        configPath: current.configPath,
        cwd: current.projectDir,
        baseUrl: session.settings.baseUrl ?? undefined,
      }),
    );
  } catch {
    // A config that stopped loading between two requests is the project's
    // business; the page keeps showing what it last resolved.
    return;
  }
  forgetBoard();
  // The judges' transcript is per run, and the cursor into the old one means
  // nothing once the targets moved.
  forgetNarration();
}

/**
 * What the settings panel shows: where lookout is pointed, and whether the
 * targets that implies actually answer right now.
 *
 * Probing here is what makes the panel worth opening: a wrong port is visible
 * before a run is spent on it, rather than after.
 */
export async function settingsView(): Promise<SettingsView> {
  const project = currentProjectOrNull();
  const configured = project?.configPath !== null && project?.configPath !== undefined;
  let targets: { name: string; url: string; routes: number; up: boolean; status: number | null }[] = [];
  let devices: { line: string; up: boolean }[] = [];
  let error: string | null = null;
  if (configured) {
    try {
      const kind = await detectProjectKind(project.projectDir, project.config);
      const statuses = kind.web
        ? await preflight(resolveTargets(project.config, undefined, undefined, project.configPath))
        : [];
      targets = statuses.map((t) => ({
        name: t.name,
        url: t.url,
        routes: t.routes,
        up: t.up,
        status: t.status,
      }));
      // The device fold's probe, as lines: what is booted, and what is not.
      const probed = await preflightDevices(project.config, kind.native);
      devices = deviceLines(probed).map((line) => ({ line, up: !/DOWN|no device booted|not configured|\(required\)$/.test(line) }));
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const dir = project?.projectDir ?? null;
  return {
    projectDir: dir,
    baseUrl: session.settings.baseUrl,
    navigation: navigationConsented(session.settings, dir),
    configPath: project?.configPath ?? null,
    project: project?.project ?? null,
    configured,
    targets,
    devices,
    error,
  };
}
