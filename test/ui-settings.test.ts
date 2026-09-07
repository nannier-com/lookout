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
  validModel,
} from "../src/ui/stored-settings.js";
import { tmpProject } from "./tmp-project.js";
import { checkArgs } from "../src/ui/run.js";

describe("stored ui settings", () => {
  test("kept in the project they describe, and an unwritten file consents to nothing", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    expect(settingsPath(dir)).toBe(join(dir, ".lookout", "ui.json"));
    expect(await loadSettings(dir)).toEqual({ ...EMPTY_SETTINGS });

    await saveSettings(dir, { ...EMPTY_SETTINGS, navigationFor: dir });
    expect(await loadSettings(dir)).toEqual({ ...EMPTY_SETTINGS, navigationFor: dir });
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
      ...EMPTY_SETTINGS,
      baseUrl: "http://127.0.0.1:5173",
      projectDir: "/somewhere/else",
    });
  });

  test("remembering a project rewrites only the pointer", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    await saveSettings(dir, { ...EMPTY_SETTINGS, baseUrl: "http://127.0.0.1:5173", navigationFor: dir });
    await rememberProject(dir, "/elsewhere");
    // The base URL and the consent belong to this project and are none of the
    // pointer's business: a read-modify-write is what keeps them.
    expect(await loadSettings(dir)).toEqual({
      ...EMPTY_SETTINGS,
      baseUrl: "http://127.0.0.1:5173",
      navigationFor: dir,
      projectDir: "/elsewhere",
    });
  });
});

describe("a model name that can be handed to a CLI", () => {
  test("takes the shapes the vendors actually use", () => {
    expect(validModel("fable")).toBe("fable");
    expect(validModel(" claude-fable-5 ")).toBe("claude-fable-5");
    expect(validModel("gpt-6.1")).toBe("gpt-6.1");
    expect(validModel("us.anthropic:claude_v2")).toBe("us.anthropic:claude_v2");
  });

  // The value becomes the word after `--model` in a spawn, so a leading dash is
  // a setting that arrives as an option nobody typed.
  test("and refuses anything that would arrive as a flag, or as nothing", () => {
    expect(validModel("--dangerously-skip-permissions")).toBeNull();
    expect(validModel("-fable")).toBeNull();
    expect(validModel("")).toBeNull();
    expect(validModel("   ")).toBeNull();
    expect(validModel("fable; rm -rf /")).toBeNull();
    expect(validModel("a".repeat(81))).toBeNull();
  });

  test("a stored file keeps only the entries that still pass", async () => {
    const dir = tmpProject("lookout-uiset-").projectDir;
    await Bun.write(
      settingsPath(dir),
      JSON.stringify({ judgeModels: { "claude-code": "fable", bad: "--flag", worse: 7 } }),
    );
    expect((await loadSettings(dir)).judgeModels).toEqual({ "claude-code": "fable" });
  });
});

describe("what the play button spends", () => {
  const dir = "/a/project";

  test("one run, stopping at the first issue, and nothing else by default", () => {
    expect(checkArgs("/cli.js", { ...EMPTY_SETTINGS }, dir))
      .toEqual(["/cli.js", "check", "--quiet", "--first"]);
  });

  // The panel and the spawn are different modules, and the failure that matters
  // is them disagreeing: a page showing a model chosen while the run rules with
  // another is a verdict filed under the wrong name in the ledger.
  test("carries the model chosen under the cog", () => {
    const settings = { ...EMPTY_SETTINGS, judgeModels: { "claude-code": "fable" } };
    expect(checkArgs("/cli.js", settings, dir)).toEqual([
      "/cli.js", "check", "--quiet", "--first", "--model", "fable",
    ]);
  });

  test("and asks for the default by saying nothing", () => {
    const settings = { ...EMPTY_SETTINGS, judgeModels: {} };
    expect(checkArgs("/cli.js", settings, dir)).not.toContain("--model");
  });

  test("the consent goes only to the project it was given for", () => {
    const yes = { ...EMPTY_SETTINGS, navigationFor: dir };
    expect(checkArgs("/cli.js", yes, dir)).toContain("--navigation");
    expect(checkArgs("/cli.js", yes, "/somewhere/else")).not.toContain("--navigation");
  });
});

describe("navigationConsented", () => {
  const on = { ...EMPTY_SETTINGS, navigationFor: "/a/project" };

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
