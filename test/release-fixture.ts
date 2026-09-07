// Execute the workflow's real shell steps against a local bare remote. The
// fixture's gates record their inputs; no test invokes a publish command.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
}
interface Workflow {
  jobs: Record<string, { if?: string; steps: Step[]; "continue-on-error"?: boolean }>;
}
export const release = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as Workflow;
export const ci = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as Workflow;
export const validation = (Bun.YAML.parse(
  readFileSync(join(ROOT, ".github/actions/validate/action.yml"), "utf8"),
) as { runs: { using: string; steps: Step[] } }).runs;
export const steps = release.jobs.npm!.steps;
export function step(id: string): Step {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`Missing release step ${id}`);
  return found;
}
const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export class ReleaseFixture {
  readonly root = mkdtempSync(join(tmpdir(), "lookout-release-"));
  readonly repo = join(this.root, "project");
  readonly remote = join(this.root, "origin.git");
  readonly env: NodeJS.ProcessEnv;

  constructor(changeset?: string) {
    mkdirSync(this.repo);
    mkdirSync(join(this.repo, ".changeset"));
    mkdirSync(join(this.repo, "tools", "release"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(this.repo, "node_modules"), "dir");
    this.env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Release Test", GIT_AUTHOR_EMAIL: "release@example.test",
      GIT_COMMITTER_NAME: "Release Test", GIT_COMMITTER_EMAIL: "release@example.test",
      GITHUB_OUTPUT: join(this.root, "outputs"), GITHUB_STEP_SUMMARY: join(this.root, "summary"),
      RUNNER_TEMP: this.root, GATE_LOG: join(this.root, "gates"),
      PUBLISHED_MARKER: join(this.root, "publish-reached"),
      FAIL_GATE: "",
    };
    const cli = `bun ${quote(join(ROOT, "node_modules/@changesets/cli/bin.js"))}`;
    writeFileSync(join(this.repo, "package.json"), JSON.stringify({
      name: "release-fixture", version: "0.1.0",
      scripts: {
        changeset: cli, "version-packages": `${cli} version`,
        typecheck: "node gate.cjs typecheck", lint: "node gate.cjs lint", build: "node gate.cjs build",
      },
    }, null, 2) + "\n");
    writeFileSync(join(this.repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(this.repo, "CHANGELOG.md"), "# release-fixture\n");
    writeFileSync(join(this.repo, ".changeset", "README.md"), "# Changesets\n");
    const config = JSON.parse(readFileSync(join(ROOT, ".changeset/config.json"), "utf8"));
    writeFileSync(join(this.repo, ".changeset", "config.json"), JSON.stringify(config));
    if (changeset !== undefined) writeFileSync(join(this.repo, ".changeset", "release.md"), changeset);
    writeFileSync(join(this.repo, "tools/release/plan.ts"), readFileSync(join(ROOT, "tools/release/plan.ts")));
    writeFileSync(join(this.repo, "gate.cjs"), `
const { appendFileSync } = require("node:fs");
const gate = process.argv[2];
appendFileSync(process.env.GATE_LOG, gate + ":" + require("./package.json").version + "\\n");
if (process.env.FAIL_GATE === gate) process.exit(1);
`);
    writeFileSync(join(this.repo, "gate.test.ts"), `
import { test, expect } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
test("release fixture", () => {
  appendFileSync(process.env.GATE_LOG!, "test:" + JSON.parse(readFileSync("package.json", "utf8")).version + "\\n");
  expect(process.env.FAIL_GATE).not.toBe("test");
});
`);
    this.git(["init", "--initial-branch=main"]);
    this.git(["init", "--bare", "--initial-branch=main", this.remote]);
    this.git(["add", "."]);
    this.git(["commit", "-m", "fixture"]);
    this.git(["remote", "add", "origin", this.remote]);
    this.git(["push", "-u", "origin", "main"]);
  }

  git(args: string[], cwd = this.repo): string {
    return execFileSync("git", args, { cwd, env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  shell(script: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
      cwd: this.repo, env: { ...this.env, ...env }, encoding: "utf8", timeout: 30_000,
    });
  }
  outputs(): Record<string, string> {
    return Object.fromEntries(readFileSync(this.env.GITHUB_OUTPUT!, "utf8").trim().split("\n").map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)];
    }));
  }
  prepare(): void {
    const plan = this.shell(step("plan").run!);
    if (plan.status !== 0) throw new Error(plan.stdout + plan.stderr);
    const prepared = this.shell(step("prepare").run!, { CHANGESET_COUNT: this.outputs().changesets });
    if (prepared.status !== 0) throw new Error(prepared.stdout + prepared.stderr);
  }
  gateAndPush(fail = "") {
    // Bash stops at the first failing gate just as the default Actions steps
    // do. This final marker represents reaching the publish boundary only.
    return this.shell([
      ...validation.steps.map((s) => s.run),
      step("push").run,
      'printf reached > "$PUBLISHED_MARKER"',
    ].join("\n"), { RELEASE_SHA: this.outputs().sha, FAIL_GATE: fail });
  }
  advanceRemote(): string {
    const other = join(this.root, "other");
    this.git(["clone", this.remote, other]);
    writeFileSync(join(other, "new-work.txt"), "A newer commit on main.\n");
    this.git(["add", "new-work.txt"], other);
    this.git(["commit", "-m", "newer work"], other);
    this.git(["push", "origin", "main"], other);
    return this.git(["rev-parse", "HEAD"], other);
  }
  cleanup(): void { rmSync(this.root, { recursive: true, force: true }); }
}
