import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changesetCount } from "../tools/release/plan.js";
import { ci, release, ReleaseFixture, step, steps, validation } from "./release-fixture.js";

const fixtures: ReleaseFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture(change?: string): ReleaseFixture {
  const f = new ReleaseFixture(change);
  fixtures.push(f);
  return f;
}
const patch = '---\n"release-fixture": patch\n---\n\nFix a defect.\n';

describe("the release gates", () => {
  test("CI and Release share the complete gate, after preparation and before any push or publish", () => {
    expect(validation.using).toBe("composite");
    expect(validation.steps.map((s) => s.run)).toEqual([
      "bun run typecheck",
      "bun run lint",
      "bun test",
      "bun run build",
      "bunx playwright install --with-deps chromium",
      "bun run test:ui",
      "bun run test:package",
    ]);
    const shared = "./.github/actions/validate";
    expect(ci.jobs.check!.steps.some((s) => s.uses === shared)).toBe(true);
    expect(step("validate").uses).toBe(shared);
    expect(release.jobs.npm!["continue-on-error"]).not.toBe(true);
    const order = ["plan", "prepare", "validate", "push", "publish", "tags"].map((id) => steps.indexOf(step(id)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const s of [...steps.slice(0, steps.indexOf(step("tags")) + 1), ...validation.steps]) {
      expect(s.if).toBeUndefined();
      expect(s["continue-on-error"]).not.toBe(true);
    }
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe("main");
    expect(release.jobs.npm!.if).toContain("github.ref == 'refs/heads/main'");
    expect(step("prepare").env?.CHANGESET_COUNT).toBe("${{ steps.plan.outputs.changesets }}");
    expect(step("push").env?.RELEASE_SHA).toBe("${{ steps.prepare.outputs.sha }}");
    // A git mutation hidden in any earlier shell step would bypass the gate.
    for (const s of steps.slice(0, steps.indexOf(step("push")))) expect(s.run ?? "").not.toMatch(/git push/);
    for (const s of steps.slice(steps.indexOf(step("validate")))) expect(s.run ?? "").not.toMatch(/git (rebase|merge|checkout|reset)/);
  });

  for (const fail of ["typecheck", "lint", "test", "build", "chromium", "ui", "package"]) {
    test(`a failing ${fail} gate neither pushes the version commit nor reaches publishing`, () => {
      const f = fixture(patch);
      const original = f.git(["rev-parse", "origin/main"]);
      f.prepare();
      expect(f.outputs().version).toBe("0.1.1");
      const result = f.gateAndPush(fail);
      expect(result.status).not.toBe(0);
      expect(f.git(["--git-dir", f.remote, "rev-parse", "main"])).toBe(original);
      expect(existsSync(f.env.PUBLISHED_MARKER!)).toBe(false);
      const gates = readFileSync(f.env.GATE_LOG!, "utf8").trim().split("\n");
      expect(gates.at(-1)).toBe(`${fail}:0.1.1`);
      expect(gates.every((line) => line.endsWith(":0.1.1"))).toBe(true);
    });
  }

  test("passing gates push exactly the prepared commit", () => {
    const f = fixture(patch);
    f.prepare();
    const result = f.gateAndPush();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git(["--git-dir", f.remote, "rev-parse", "main"])).toBe(f.outputs().sha!);
    expect(existsSync(f.env.PUBLISHED_MARKER!)).toBe(true);
  });

  test("no pending changesets still checks the existing version before the publish boundary", () => {
    const f = fixture();
    const original = f.git(["rev-parse", "HEAD"]);
    f.prepare();
    expect(f.outputs().changesets).toBe("0");
    expect(f.outputs().sha).toBe(original);
    expect(f.git(["config", "--local", "user.name"])).toBe("github-actions[bot]");
    expect(f.git(["config", "--local", "user.email"])).toContain("@users.noreply.github.com");
    // Changesets tags with an annotation. On a fresh runner there is no
    // global identity, and recovery still needs one even without a commit.
    const tag = f.shell('env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL git tag v0.1.0 -m v0.1.0', {
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(tag.status, tag.stderr).toBe(0);
    const result = f.gateAndPush();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(f.env.GATE_LOG!, "utf8").trim().split("\n")).toEqual([
      "typecheck:0.1.0",
      "lint:0.1.0",
      "test:0.1.0",
      "build:0.1.0",
      "chromium:0.1.0",
      "ui:0.1.0",
      "package:0.1.0",
    ]);
    expect(existsSync(f.env.PUBLISHED_MARKER!)).toBe(true);
  });

  test("an advancing main rejects the push without rebasing or reaching publication", () => {
    const f = fixture(patch);
    f.prepare();
    const prepared = f.outputs().sha!;
    const advanced = f.advanceRemote();
    const result = f.gateAndPush();
    expect(result.status).not.toBe(0);
    expect(f.git(["rev-parse", "HEAD"])).toBe(prepared);
    expect(f.git(["--git-dir", f.remote, "rev-parse", "main"])).toBe(advanced);
    expect(existsSync(f.env.PUBLISHED_MARKER!)).toBe(false);
  });

  for (const mutation of ["tracked edit", "untracked file", "new commit"]) {
    test(`${mutation} after preparation refuses publication`, () => {
      const f = fixture(patch);
      f.prepare();
      const file = mutation === "tracked edit" ? "CHANGELOG.md" : "new.txt";
      writeFileSync(join(f.repo, file), "not the prepared tree\n");
      if (mutation === "new commit") {
        f.git(["add", file]);
        f.git(["commit", "-m", "changed after preparation"]);
      }
      const result = f.gateAndPush();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("checkout changed during validation");
      expect(existsSync(f.env.PUBLISHED_MARKER!)).toBe(false);
    });
  }
});

describe("version policy uses the real Changesets parser", () => {
  for (const major of ["major", '"major"', "'major'"]) {
    test(`${major} is blocked for automatic and manual runs`, () => {
      const f = fixture(`---\n"release-fixture": ${major}\n---\n\nBreaking change.\n`);
      for (const event of ["push", "workflow_dispatch"]) {
        const result = f.shell(step("plan").run!, { GITHUB_EVENT_NAME: event });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Major release of release-fixture is blocked");
        expect(existsSync(f.env.GITHUB_OUTPUT!)).toBe(false);
        expect(f.git(["status", "--porcelain"])).toBe("");
      }
    });
  }
  test("a minor passes the policy without becoming a major", () => {
    const f = fixture(patch.replace(": patch", ": minor"));
    f.prepare();
    expect(f.outputs().version).toBe("0.2.0");
  });
  test("malformed plans fail closed", () => {
    for (const raw of [null, {}, { changesets: [], releases: [null] },
      { changesets: [], releases: [{ name: "x", type: "unknown" }] },
      { changesets: [], releases: [{ name: "x", type: ["major"] }] }]) {
      expect(() => changesetCount(raw)).toThrow("Invalid release");
    }
  });
});

describe("the release summary reports actual outcomes", () => {
  for (const outcome of ["failure", "skipped", "cancelled"]) {
    test(`${outcome} never claims a successful publish`, () => {
      const f = fixture();
      const summary = steps.find((s) => s.name === "Summarise the release")!;
      expect(summary.if).toBe("always()");
      const result = f.shell(summary.run!, { RELEASE_VERSION: "0.1.0", PUBLISH_OUTCOME: outcome, TAGS_OUTCOME: "skipped" });
      expect(result.status).toBe(0);
      const text = readFileSync(f.env.GITHUB_STEP_SUMMARY!, "utf8");
      expect(text).not.toContain("Release command succeeded");
      expect(text).not.toContain("Published **");
      expect(text).toContain(outcome === "failure" ? "Publishing failed" : "Publishing did not run successfully");
    });
  }
  test("tag failure after publish is described as incomplete", () => {
    const f = fixture();
    const summary = steps.find((s) => s.name === "Summarise the release")!;
    expect(f.shell(summary.run!, { RELEASE_VERSION: "0.1.0", PUBLISH_OUTCOME: "success", TAGS_OUTCOME: "failure" }).status).toBe(0);
    expect(readFileSync(f.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("Release is incomplete");
  });
});
