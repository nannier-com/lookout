/**
 * Which project `lookout ui` serves, and what it writes to find out.
 *
 * It starts in the directory it was launched in, and can be pointed at another
 * project from the settings panel afterwards. Both halves are worth a test:
 * the startup decision is the difference between a page that configures a
 * project and one that litters a directory that is not a project, and the
 * switch is the difference between a pointer that is remembered where it can
 * be read back and one stored inside the thing it points at.
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
    session.settings = { baseUrl: null, navigationFor: null, projectDir: null };
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

describe("pointing the page at another project", () => {
  /** A server launched in `launch`, serving it, with nothing remembered yet. */
  function launchedIn(launch: ResolvedConfig): void {
    setCurrentProject(launch);
    session.launchDir = launch.projectDir;
    session.settings = { baseUrl: null, navigationFor: null, projectDir: null };
    session.queue = [];
  }

  async function point(dir: string): Promise<Response | undefined> {
    return handle(
      new Request("http://127.0.0.1/api/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir }),
      }),
      null as never,
    );
  }

  test("serves it, and remembers it in the directory the server was launched in", async () => {
    const launch = tmpProject("lookout-launch-");
    const other = tmpProject("lookout-other-");
    launchedIn(launch);

    const res = await point(other.projectDir);
    expect(res?.status).toBe(200);
    expect((await res!.json()).projectDir).toBe(other.projectDir);

    // The pointer goes where a server started here will look for it, which is
    // never the project it points at: that one cannot be found without it.
    expect(JSON.parse(readFileSync(settingsPath(launch.projectDir), "utf8"))).toMatchObject({
      projectDir: other.projectDir,
    });
    expect(existsSync(settingsPath(other.projectDir))).toBe(false);
  });

  test("a repository with no config gets one, the way a launch there would", async () => {
    launchedIn(tmpProject("lookout-launch-"));
    const dir = repo();
    const res = await point(dir);
    expect(res?.status).toBe(200);
    expect(existsSync(join(dir, "lookout.config.ts"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".lookout/");
  });

  test("a directory that is no project is refused, and nothing is written", async () => {
    const launch = tmpProject("lookout-launch-");
    launchedIn(launch);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "lookout-bare-")));

    const res = await point(bare);
    expect(res?.status).toBe(400);
    expect((await res!.json()).error).toMatch(/is not a repository/);
    expect(existsSync(join(bare, "lookout.config.ts"))).toBe(false);
    expect(existsSync(join(bare, ".lookout"))).toBe(false);
    // Refused means nothing was remembered either: the launch directory is not
    // written to at all, so a restart comes back serving what it always did.
    expect(existsSync(settingsPath(launch.projectDir))).toBe(false);
  });

  test("a path that is not a directory at all is refused", async () => {
    const launch = tmpProject("lookout-launch-");
    launchedIn(launch);
    const res = await point(join(launch.projectDir, "lookout.config.ts"));
    expect(res?.status).toBe(400);
    expect((await res!.json()).error).toMatch(/not a directory/);
  });

  test("an empty path is refused before anything is resolved", async () => {
    launchedIn(tmpProject("lookout-launch-"));
    const res = await point("   ");
    expect(res?.status).toBe(400);
    expect((await res!.json()).error).toBe("no folder given");
  });
});
