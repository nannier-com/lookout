/**
 * What the settings panel shows, and what it can change.
 *
 * Two changes, and they are not the same size. The base URL re-resolves the
 * config it already has; the project re-resolves everything, because pointing
 * lookout at another repository is not a patch on the one being served but a
 * different config, queue, settings and board in its place. The probe is what
 * makes the panel worth opening when neither changes: "which targets answer
 * right now" shows a wrong port before a run is spent on it.
 *
 * The choice is remembered, in the directory the server was STARTED in rather
 * than the one it ends up serving (`rememberProject`). That is the whole
 * difference from the picker this replaces, which kept its answer in the
 * operator's home: a pointer cannot live inside the thing it points to, but it
 * can live perfectly well beside the directory that launched the process, and
 * that needs no machine-wide home.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { locateOrCreateConfig } from "../config-write.js";
import { preflight, resolveTargets } from "../targets.js";
import { deviceLines, preflightDevices } from "../capture/native-preflight.js";
import { detectProjectKind } from "../project-kind.js";
import { DEFAULT_JUDGE_MODEL, JUDGES } from "../judge/engine.js";
import { claudeBin } from "../judge/claude.js";
import { probeCli } from "../judge/cli-probe.js";
import { toolsAvailable } from "../report/handoff.js";
import { execFileAsync } from "../util.js";
import { currentProjectOrNull, session, setCurrentProject } from "./session.js";
import { forgetNarration } from "./narration.js";
import { forgetBoard } from "./payload.js";
import { loadQueue, queueMtime } from "./queue.js";
import { loadSettings, navigationConsented, rememberProject } from "./stored-settings.js";

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
   * The AIs lookout can judge this project with, and which model each uses.
   *
   * `model` is what has been chosen, or null for lookout's own default, which
   * travels beside it so the page can say what the default IS rather than
   * printing a name of its own that could drift from the verbs.
   */
  judges: {
    key: string;
    label: string;
    model: string | null;
    defaultModel: string;
    installed: boolean;
    /**
     * The model names this CLI offers, asked of the install itself.
     *
     * Empty when it could not be asked, which is the panel's signal to take a
     * typed name instead of showing a menu with nothing in it. lookout never
     * adds a name of its own to this: a menu that outlived the CLI it describes
     * would be wrong while looking authoritative, which is why the list is a
     * probe rather than a constant.
     */
    models: string[];
    /** The installed CLI's version, so the menu says which install it came from. */
    version: string | null;
  }[];
  /**
   * The device fold, one line per booted device or per gap, in the words
   * `lookout targets` prints. Empty for a project judged in the web fold only.
   */
  devices: { line: string; up: boolean }[];
  error: string | null;
}

/**
 * Ask the operating system for a directory.
 *
 * A browser cannot hand back a real filesystem path, so the server asks
 * instead. lookout is already a local process the user started, so putting a
 * native picker in front of them is no more privileged than the terminal they
 * launched it from.
 */
export async function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose the repository lookout should check")',
    ]);
    const dir = stdout.trim().replace(/\/$/, "");
    return dir || null;
  } catch {
    // The user cancelled, which is not an error.
    return null;
  }
}

/**
 * Point this server at another project, and remember that it was pointed.
 *
 * Everything scoped to one project follows the move: that project's config,
 * its own base URL and consent, its queue, the board cache and the judges'
 * transcript, which would otherwise go on describing the project just left.
 * The watcher needs no help; it listens for exactly this.
 *
 * The config is found or written the same way `lookout ui` decides it at
 * startup, because this panel is the same kind of screen a terminal is: the
 * one a project gets configured ON. A directory that is no project at all is
 * refused rather than littered.
 *
 * Returns the reason it could not, or null when it did. An error rather than a
 * throw because a folder somebody picked by hand being the wrong folder is an
 * ordinary answer, not a failed request.
 */
export async function switchProject(dir: string): Promise<string | null> {
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return `not a directory: ${abs}`;
  const found = await locateOrCreateConfig(abs);
  if (!found) return `${abs} holds no lookout.config.ts and is not a repository`;

  // This project's own remembered base URL, applied as the config loads, so the
  // panel and the run it starts agree about where the app is from the first
  // paint rather than after a save.
  const settings = await loadSettings(found.projectDir);
  let resolved;
  try {
    resolved = await loadConfig({
      configPath: found.configPath,
      cwd: found.projectDir,
      baseUrl: settings.baseUrl ?? undefined,
    });
  } catch (e) {
    return (e as Error).message;
  }

  setCurrentProject(resolved);
  session.settings = settings;
  session.queue = await loadQueue(found.projectDir);
  session.queueMtime = queueMtime(found.projectDir);
  session.queueRev++;
  forgetBoard();
  forgetNarration();
  // Remembered against the directory this server was launched in, so the next
  // one started there comes back pointed here.
  if (session.launchDir) await rememberProject(session.launchDir, found.projectDir);
  if (found.created) console.error(`lookout: wrote ${found.configPath}`);
  return null;
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
/**
 * One row per AI lookout can ask to judge, with what it would use today.
 *
 * The installed flag is the same probe the tool picker runs, because the
 * answer to "why did that run not judge" is usually that the binary is not
 * there, and a model chosen for a CLI nobody has is worth saying out loud.
 */
async function judgeViews(): Promise<SettingsView["judges"]> {
  const tools = await toolsAvailable();
  return Promise.all(
    JUDGES.map(async (key) => {
      const tool = tools.find((t) => t.key === key);
      // The binary the ADAPTER would spawn, not the one the tool picker probes
      // for. They are the same install normally and different whenever
      // LOOKOUT_CLAUDE_BIN is set, and it is the judging one that the panel is
      // describing: a version and a model menu read off some other copy of the
      // CLI would describe a run that is not the one this button starts.
      const facts = await probeCli(key === "claude-code" ? claudeBin() : (tool?.bin ?? key));
      return {
        key,
        label: tool?.label ?? key,
        model: session.settings.judgeModels[key] ?? null,
        defaultModel: DEFAULT_JUDGE_MODEL,
        installed: tool?.installed ?? false,
        models: facts.models,
        version: facts.version,
      };
    }),
  );
}

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
    judges: await judgeViews(),
    error,
  };
}
