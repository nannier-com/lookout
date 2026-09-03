// What the page remembers between runs, and the one comparison that decides
// whether the run it starts will click the application's own controls.
//
// The consent under the cog and the spawn that honours it are in different
// modules and must never disagree, so the comparison is a function and this is
// the test of it.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  EMPTY_SETTINGS,
  loadSettings,
  navigationConsented,
  rememberProject,
  saveSettings,
  settingsPath,
} from "../src/ui/stored-settings.js";
import { tmpProject } from "./tmp-project.js";

describe("stored ui settings", () => {
  test("kept in the project they describe, and an unwritten file consents to nothing", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    expect(settingsPath(dir)).toBe(join(dir, ".lookout", "ui.json"));
    expect(await loadSettings(dir)).toEqual({ ...EMPTY_SETTINGS });

    await saveSettings(dir, { baseUrl: null, navigationFor: dir, projectDir: null });
    expect(await loadSettings(dir)).toEqual({ baseUrl: null, navigationFor: dir, projectDir: null });
  });

  test("settings written before the field existed load as no consent", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    await Bun.write(settingsPath(dir), JSON.stringify({ projectDir: "/a/project", baseUrl: null }));
    expect((await loadSettings(dir)).navigationFor).toBeNull();
  });

  // The field names which project a server started in THIS directory should
  // serve. It is read back rather than past, which is what makes a choice made
  // in the settings panel survive the restart; the directory it is stored in is
  // the launch directory, never the one it points at.
  test("a stored projectDir is the pointer a server launched here follows", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    await Bun.write(
      settingsPath(dir),
      JSON.stringify({ projectDir: "/somewhere/else", baseUrl: "http://127.0.0.1:5173", navigationFor: null }),
    );
    expect(await loadSettings(dir)).toEqual({
      baseUrl: "http://127.0.0.1:5173",
      navigationFor: null,
      projectDir: "/somewhere/else",
    });
  });

  test("remembering a project rewrites only the pointer", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    await saveSettings(dir, { baseUrl: "http://127.0.0.1:5173", navigationFor: dir, projectDir: null });
    await rememberProject(dir, "/elsewhere");
    // The base URL and the consent belong to this project and are none of the
    // pointer's business: a read-modify-write is what keeps them.
    expect(await loadSettings(dir)).toEqual({
      baseUrl: "http://127.0.0.1:5173",
      navigationFor: dir,
      projectDir: "/elsewhere",
    });
  });
});

describe("navigationConsented", () => {
  const on = { baseUrl: null, navigationFor: "/a/project", projectDir: null };

  test("holds only for the project the yes was given for", () => {
    expect(navigationConsented(on, "/a/project")).toBe(true);
    // The reason consent is stored with a directory rather than as a boolean:
    // pointing the page at a second repository must not carry the first one's
    // permission to click its buttons across.
    expect(navigationConsented(on, "/another/project")).toBe(false);
    expect(navigationConsented(on, null)).toBe(false);
    expect(navigationConsented({ ...on, navigationFor: null }, "/a/project")).toBe(false);
  });
});
