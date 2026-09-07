/**
 * What the page knows between polls.
 *
 * One object rather than a module-level variable in each file, because these
 * five things are read and written across every part of the page: the filter
 * decides what the board renders, the project decides whether the play button
 * is even live, and the notice outranks the path in the same element. Kept
 * declarative and small on purpose. It is the one file every other client
 * module touches, so it should be the one that almost never changes.
 *
 * `refresh` is the exception, and it exists to keep the dependency graph
 * acyclic. Several actions have to redraw the page when they finish, but the
 * poll that redraws it needs every renderer, so a module that called it
 * directly would import its own importer. The loop registers itself here at
 * startup instead, and the actions ask for a redraw without knowing what does
 * the drawing.
 */
import type { SettingsView } from "../project.js";

/** Which headline number the reader clicked, if any. */
export interface Filter {
  kind: "state" | "severity";
  value: string;
  label: string;
}

export const page: {
  /**
   * Clicking a headline number narrows the page to the work it counts. Held
   * here rather than in the URL because it is a view, not a place: a reload
   * should come back to everything outstanding.
   */
  filter: Filter | null;
  /** Which area the rail has selected. A view, not a place, for the same reason. */
  view: string;
  /**
   * Why the last thing you asked for did not happen.
   *
   * Held as state rather than written straight into the element, because the
   * poll rewrites that element every 1.5 seconds and used to erase every
   * explanation the page produced within a second of it appearing.
   */
  notice: string | null;
  /** Where lookout is pointed, and whether it can run there at all. */
  project: { configured: boolean; projectDir: string; checkRunning: boolean; checkStopping: boolean };
  /** What the settings panel is showing, so play can refuse without a round trip. */
  config: SettingsView;
} = {
  filter: null,
  view: "issues",
  notice: null,
  project: { configured: false, projectDir: "", checkRunning: false, checkStopping: false },
  config: {
    configured: false,
    projectDir: null,
    baseUrl: null,
    navigation: false,
    configPath: null,
    project: null,
    targets: [],
    judges: [],
    devices: [],
    error: null,
  },
};

let refreshNow: () => Promise<void> = () => Promise.resolve();

/** The poll registers itself here once, at startup. */
export function onRefresh(fn: () => Promise<void>): void {
  refreshNow = fn;
}

/** Redraw the page from the server, without knowing what draws it. */
export function refresh(): Promise<void> {
  return refreshNow();
}
