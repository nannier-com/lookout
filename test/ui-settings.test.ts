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
  saveSettings,
  settingsPath,
} from "../src/ui/stored-settings.js";
import { tmpProject } from "./tmp-project.js";

describe("stored ui settings", () => {
  test("kept in the project they describe, and an unwritten file consents to nothing", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    expect(settingsPath(dir)).toBe(join(dir, ".lookout", "ui.json"));
    expect(await loadSettings(dir)).toEqual({ ...EMPTY_SETTINGS });

    await saveSettings(dir, { baseUrl: null, navigationFor: dir });
    expect(await loadSettings(dir)).toEqual({ baseUrl: null, navigationFor: dir });
  });

  test("settings written before the field existed load as no consent", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    await Bun.write(settingsPath(dir), JSON.stringify({ projectDir: "/a/project", baseUrl: null }));
    expect((await loadSettings(dir)).navigationFor).toBeNull();
  });

  // Written by a lookout that kept one file for every project. The field named
  // which project the page was pointed at, a question this file no longer
  // answers, so it is read past rather than resurrected.
  test("a projectDir left by an older lookout is ignored, not carried", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    await Bun.write(
      settingsPath(dir),
      JSON.stringify({ projectDir: "/somewhere/else", baseUrl: "http://127.0.0.1:5173", navigationFor: null }),
    );
    const loaded = await loadSettings(dir);
    expect(loaded).toEqual({ baseUrl: "http://127.0.0.1:5173", navigationFor: null });
    expect("projectDir" in loaded).toBe(false);
  });
});

describe("navigationConsented", () => {
  const on = { baseUrl: null, navigationFor: "/a/project" };

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
