// What the page remembers between runs, and the one comparison that decides
// whether the run it starts will click the application's own controls.
//
// The consent under the cog and the spawn that honours it are in different
// modules and must never disagree, so the comparison is a function and this is
// the test of it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_SETTINGS,
  loadSettings,
  navigationConsented,
  saveSettings,
  settingsPath,
} from "../src/ui/stored-settings.js";

/** A throwaway lookout home, so the real one is never read or written. */
const REAL_HOME = process.env.LOOKOUT_HOME;
function withHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lookout-uiset-"));
  process.env.LOOKOUT_HOME = home;
  return home;
}
afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.LOOKOUT_HOME;
  else process.env.LOOKOUT_HOME = REAL_HOME;
});

describe("stored ui settings", () => {
  test("consent survives a round trip, and an unwritten file consents to nothing", async () => {
    const home = withHome();
    expect(settingsPath().startsWith(home)).toBe(true);
    expect(await loadSettings()).toEqual({ ...EMPTY_SETTINGS });

    await saveSettings({ projectDir: "/a/project", baseUrl: null, navigationFor: "/a/project" });
    expect(await loadSettings()).toEqual({
      projectDir: "/a/project",
      baseUrl: null,
      navigationFor: "/a/project",
    });
  });

  test("settings written before the field existed load as no consent", async () => {
    const home = withHome();
    await Bun.write(join(home, "ui.json"), JSON.stringify({ projectDir: "/a/project", baseUrl: null }));
    expect((await loadSettings()).navigationFor).toBeNull();
  });
});

describe("navigationConsented", () => {
  const on = { projectDir: "/a/project", baseUrl: null, navigationFor: "/a/project" };

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
