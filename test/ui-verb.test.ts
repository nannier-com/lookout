/**
 * Which project `lookout ui` serves, and what it writes to find out.
 *
 * The page used to be re-pointable at runtime and to remember where it had
 * been pointed, which is what kept its settings in the operator's home. It
 * serves the directory it was started in now, so the decision it makes at
 * startup is worth a test of its own: it is the difference between a page that
 * configures a project and one that litters a directory that is not a project.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectToServe } from "../src/verbs/ui.js";
import { handle } from "../src/ui/routes.js";
import { session, setCurrentProject } from "../src/ui/session.js";
import { settingsPath } from "../src/ui/stored-settings.js";
import { tmpProject } from "./tmp-project.js";
import type { ResolvedConfig } from "../src/types.js";

const noFlags = { positionals: [], flags: {} };

/**
 * A repository with nothing in it: a project root, with no lookout config.
 *
 * Realpathed, because `process.chdir` reports the resolved path and macOS
 * spells the temp directory both ways.
 */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookout-uiverb-")));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "package.json"), '{ "name": "fixture" }\n');
  return dir;
}

function inDir<T>(dir: string, fn: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

describe("the project lookout ui serves", () => {
  test("the one it was started in, when that project has a config", async () => {
    const r = tmpProject("lookout-uiverb-");
    const served = await inDir(r.projectDir, () => projectToServe(noFlags));
    // Realpathed on both sides: chdir resolves the /var symlink macOS hands
    // back from mkdtemp, and that difference is not the subject.
    expect(served).toBe(realpathSync(r.projectDir));
  });

  test("a repository with no config gets one, and the ignore line with it", async () => {
    const dir = repo();
    const served = await inDir(dir, () => projectToServe(noFlags));
    expect(served).toBe(dir);
    // Written rather than refused: this is the screen a project is configured
    // ON, so stopping to say "edit this file and re-run" is the wrong shape.
    expect(existsSync(join(dir, "lookout.config.ts"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".lookout/");
  });

  test("a directory that is no project at all is refused, not littered", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "lookout-bare-")));
    await expect(inDir(bare, () => projectToServe(noFlags))).rejects.toThrow(/no project here/);
    expect(existsSync(join(bare, "lookout.config.ts"))).toBe(false);
    expect(existsSync(join(bare, ".lookout"))).toBe(false);
  });

  test("--url and --config keep their zero-config look, writing nothing", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "lookout-bare-")));
    const served = await inDir(bare, () =>
      projectToServe({ positionals: [], flags: { url: "http://127.0.0.1:1" } }),
    );
    expect(served).toBeNull();
    expect(existsSync(join(bare, "lookout.config.ts"))).toBe(false);
  });
});

describe("what the settings route will write", () => {
  test("into the project it is serving", async () => {
    const r = tmpProject("lookout-uiset-route-");
    setCurrentProject(r);
    session.settings = { baseUrl: null, navigationFor: null };
    const res = await handle(
      new Request("http://127.0.0.1/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:5173" }),
      }),
      null as never,
    );
    expect(res?.status).toBe(200);
    expect(JSON.parse(readFileSync(settingsPath(r.projectDir), "utf8"))).toMatchObject({
      baseUrl: "http://127.0.0.1:5173",
    });
  });

  test("and nothing at all when there is no config to remember it for", async () => {
    const bare = mkdtempSync(join(tmpdir(), "lookout-bare-"));
    const unconfigured: ResolvedConfig = {
      config: { targets: [] },
      configPath: null,
      projectDir: bare,
      project: "lookout",
    };
    setCurrentProject(unconfigured);
    const res = await handle(
      new Request("http://127.0.0.1/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:5173" }),
      }),
      null as never,
    );
    expect(res?.status).toBe(409);
    expect(existsSync(join(bare, ".lookout"))).toBe(false);
  });
});
