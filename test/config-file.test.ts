// Where the config lives, who writes it, and what happens to a project still
// holding the old one. The move from .lookout/config.ts to a root
// lookout.config.ts is only safe if the references inside it move too, so that
// is asserted rather than assumed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { locateConfig, nearestProjectRoot, projectDirFor } from "../src/config-locate.js";
import { createConfig, ensureProjectConfig, migrateLegacyConfig } from "../src/config-write.js";

const ONE_TARGET = 'export default { targets: [{ name: "app", url: "http://localhost:3000" }] };\n';

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookout-config-")));
  writeFileSync(join(dir, "package.json"), '{ "name": "fixture" }\n');
  return dir;
}

function legacyProject(body = ONE_TARGET): { dir: string; config: string } {
  const dir = project();
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const config = join(dir, ".lookout", "config.ts");
  writeFileSync(config, body);
  return { dir, config };
}

describe("locating the config", () => {
  test("finds lookout.config.ts at the project root", () => {
    const dir = project();
    writeFileSync(join(dir, "lookout.config.ts"), ONE_TARGET);
    const found = locateConfig(dir);
    expect(found?.path).toBe(join(dir, "lookout.config.ts"));
    expect(found?.projectDir).toBe(dir);
    expect(found?.legacy).toBe(false);
  });

  test("still finds the old .lookout/config.ts, and says it is the old one", () => {
    const { dir, config } = legacyProject();
    const found = locateConfig(dir);
    expect(found?.path).toBe(config);
    expect(found?.projectDir).toBe(dir);
    expect(found?.legacy).toBe(true);
  });

  test("the root config wins over an old one in the same project", () => {
    const { dir } = legacyProject();
    writeFileSync(join(dir, "lookout.config.ts"), ONE_TARGET);
    expect(locateConfig(dir)?.path).toBe(join(dir, "lookout.config.ts"));
  });

  test("a nearer directory wins over a further one, whichever form each uses", () => {
    const outer = project();
    writeFileSync(join(outer, "lookout.config.ts"), ONE_TARGET);
    const inner = join(outer, "packages", "app");
    mkdirSync(join(inner, ".lookout"), { recursive: true });
    writeFileSync(join(inner, ".lookout", "config.ts"), ONE_TARGET);
    expect(locateConfig(inner)?.path).toBe(join(inner, ".lookout", "config.ts"));
    expect(locateConfig(join(outer, "packages"))?.path).toBe(join(outer, "lookout.config.ts"));
  });

  test("the project root a config implies depends on which home it is in", () => {
    expect(projectDirFor("/repo/lookout.config.ts")).toBe("/repo");
    expect(projectDirFor("/repo/.lookout/config.ts")).toBe("/repo");
    expect(projectDirFor("/repo/config/lookout.config.ts")).toBe("/repo/config");
  });

  test("a directory that is not a project has no root to write into", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookout-bare-")));
    expect(nearestProjectRoot(dir)).toBe(null);
    expect(nearestProjectRoot(project())).not.toBe(null);
  });

  test("the home directory is never the project root, dotfiles repo or not", () => {
    // Plenty of people keep ~ in git; a run from an unrelated folder under it
    // must not answer by writing a config into their home.
    expect(nearestProjectRoot(homedir())).not.toBe(homedir());
  });
});

describe("loading from the root", () => {
  test("evidence roots at the directory holding the config", async () => {
    const dir = project();
    writeFileSync(join(dir, "lookout.config.ts"), ONE_TARGET);
    const resolved = await loadConfig({ cwd: dir });
    expect(resolved.projectDir).toBe(dir);
    expect(resolved.configPath).toBe(join(dir, "lookout.config.ts"));
  });

  test("an old config still roots at the project, not at .lookout/", async () => {
    const { dir } = legacyProject();
    expect((await loadConfig({ cwd: dir })).projectDir).toBe(dir);
  });

  test("--config pointing into .lookout/ roots at the project too", async () => {
    const { dir, config } = legacyProject();
    expect((await loadConfig({ configPath: config, cwd: "/" })).projectDir).toBe(dir);
  });
});

describe("lookout writing the config", () => {
  test("createConfig writes a loadable file and never overwrites one", async () => {
    const dir = project();
    const path = await createConfig(dir, { url: "http://localhost:4321" });
    expect(path).toBe(join(dir, "lookout.config.ts"));
    const resolved = await loadConfig({ cwd: dir });
    expect(resolved.config.targets[0]!.url).toBe("http://localhost:4321");
    expect(createConfig(dir)).rejects.toThrow(/already exists/);
  });

  test("the startHint follows the project's lockfile, npm when there is none", async () => {
    const bun = project();
    writeFileSync(join(bun, "bun.lockb"), "");
    expect(readFileSync(await createConfig(bun), "utf8")).toContain('startHint: "bun run dev"');

    const pnpm = project();
    writeFileSync(join(pnpm, "pnpm-lock.yaml"), "");
    expect(readFileSync(await createConfig(pnpm), "utf8")).toContain('startHint: "pnpm dev"');

    expect(readFileSync(await createConfig(project()), "utf8")).toContain('startHint: "npm run dev"');
  });
});

describe("migrating the old config", () => {
  test("moves the file to the root and keeps its contents", async () => {
    const { dir, config } = legacyProject();
    const moved = await migrateLegacyConfig(config);
    expect(moved.to).toBe(join(dir, "lookout.config.ts"));
    expect(existsSync(config)).toBe(false);
    expect(readFileSync(moved.to, "utf8")).toBe(ONE_TARGET);
  });

  test("repoints a rubric that lived beside the old config", async () => {
    const { dir, config } = legacyProject(
      'export default { rubric: "./rubric.md", targets: [{ name: "app", url: "http://localhost:1" }] };\n',
    );
    writeFileSync(join(dir, ".lookout", "rubric.md"), "# project rules\n");
    const moved = await migrateLegacyConfig(config);
    expect(moved.rewritten).toEqual(["./rubric.md -> .lookout/rubric.md"]);
    const resolved = await loadConfig({ cwd: dir });
    expect(existsSync(join(dir, resolved.config.rubric!))).toBe(true);
  });

  test("leaves a reference it cannot place alone, and says which", async () => {
    const { dir, config } = legacyProject(
      'const shared = "shot.png";\n' +
        "export default { targets: [{ name: \"app\", url: \"http://localhost:1\", routes: [" +
        '{ path: "/a", design: shared }, { path: "/b", design: "shot.png" }] }] };\n',
    );
    writeFileSync(join(dir, ".lookout", "shot.png"), "not really a png");
    const moved = await migrateLegacyConfig(config);
    expect(moved.rewritten).toEqual([]);
    expect(moved.unresolved).toEqual(["shot.png"]);
  });
});

describe("ensureProjectConfig", () => {
  test("moves an old config out of the way of the run that found it", async () => {
    const { dir, config } = legacyProject();
    expect(await ensureProjectConfig({ cwd: dir })).toBe("go");
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(dir, "lookout.config.ts"))).toBe(true);
  });

  test("a second run over the same project is a no-op, not a second move", async () => {
    const { dir } = legacyProject();
    expect(await ensureProjectConfig({ cwd: dir })).toBe("go");
    expect(await ensureProjectConfig({ cwd: dir })).toBe("go");
    expect(readFileSync(join(dir, "lookout.config.ts"), "utf8")).toBe(ONE_TARGET);
  });

  test("refuses to move onto a root config that is already there", async () => {
    const { dir, config } = legacyProject();
    writeFileSync(join(dir, "lookout.config.ts"), ONE_TARGET);
    expect(migrateLegacyConfig(config)).rejects.toThrow(/already exists/);
  });

  test("writes a config seeded from --url and lets the run go on", async () => {
    const dir = project();
    expect(await ensureProjectConfig({ cwd: dir, url: "http://localhost:5173" })).toBe("go");
    expect((await loadConfig({ cwd: dir })).config.targets[0]!.url).toBe("http://localhost:5173");
  });

  test("writes a template with nothing to seed it, and stops the run", async () => {
    const dir = project();
    expect(await ensureProjectConfig({ cwd: dir })).toBe("stop");
    expect(existsSync(join(dir, "lookout.config.ts"))).toBe(true);
  });

  test("leaves a configured project and an explicit --config alone", async () => {
    const dir = project();
    writeFileSync(join(dir, "lookout.config.ts"), ONE_TARGET);
    expect(await ensureProjectConfig({ cwd: dir })).toBe("go");
    expect(readFileSync(join(dir, "lookout.config.ts"), "utf8")).toBe(ONE_TARGET);

    const bare = realpathSync(mkdtempSync(join(tmpdir(), "lookout-bare-")));
    expect(await ensureProjectConfig({ cwd: bare, configPath: "/somewhere/else.ts" })).toBe("go");
    expect(existsSync(join(bare, "lookout.config.ts"))).toBe(false);
  });

  test("writes nothing in a directory that is not a project", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "lookout-bare-")));
    expect(await ensureProjectConfig({ cwd: bare, url: "http://localhost:1" })).toBe("go");
    expect(existsSync(join(bare, "lookout.config.ts"))).toBe(false);
  });
});
