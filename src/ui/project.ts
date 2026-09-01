/**
 * Where lookout is pointed, and whether it can see anything there.
 *
 * The page is where a project gets chosen now, which is why this is a module
 * rather than a line in the router: choosing means asking the operating system
 * for a directory, re-resolving the config under it, and saying honestly when
 * there is no config to resolve. The probe belongs here too, because "which
 * targets answer right now" is the only question that makes the settings panel
 * worth opening.
 */
import { loadConfig } from "../config.js";
import { preflight, resolveTargets } from "../targets.js";
import { currentProject, currentProjectOrNull, session, setCurrentProject } from "./session.js";
import { forgetBoard } from "./payload.js";
import { execFileAsync } from "../util.js";

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

/** What the page is told after being pointed somewhere. */
export interface ProjectView {
  project?: string;
  projectDir: string;
  configured: boolean;
  /** Set when there was nothing to point at, and absent otherwise. */
  error?: string;
}

/** What the settings panel shows: where lookout is pointed, and what answers. */
export interface SettingsView {
  projectDir: string | null;
  baseUrl: string | null;
  configPath: string | null;
  project: string | null;
  configured: boolean;
  targets: { name: string; url: string; routes: number; up: boolean; status: number | null }[];
  error: string | null;
}

/** Point lookout at a directory, reporting honestly when it has no config. */
export async function useProject(dir: string): Promise<ProjectView> {
  try {
    setCurrentProject(await loadConfig({ cwd: dir, baseUrl: session.settings.baseUrl ?? undefined }));
  } catch {
    // No config found up the tree: say so rather than serving an empty board
    // that looks like a project with nothing wrong with it.
    return { projectDir: dir, configured: false, error: "no lookout.config.ts found there" };
  }
  forgetBoard();
  return {
    project: currentProject().project,
    projectDir: currentProject().projectDir,
    configured: currentProject().configPath !== null,
  };
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
  let error: string | null = null;
  if (configured) {
    try {
      const statuses = await preflight(
        resolveTargets(project.config, undefined, undefined, project.configPath),
      );
      targets = statuses.map((t) => ({
        name: t.name,
        url: t.url,
        routes: t.routes,
        up: t.up,
        status: t.status,
      }));
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return {
    projectDir: session.settings.projectDir ?? project?.projectDir ?? null,
    baseUrl: session.settings.baseUrl,
    configPath: project?.configPath ?? null,
    project: project?.project ?? null,
    configured,
    targets,
    error,
  };
}
