// lookout editing lookout.
//
// This is the most dangerous verb in the codebase: it changes the code that
// does the judging. What makes it acceptable is that nothing the healer says
// is trusted. It may read and edit inside lookout's own checkout and may not
// run a command, so whether the change is good is never its own report;
// lookout runs the gates and reverts everything if any of them fails.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHeld, ownCheckout, selfHeal } from "../src/verbs/self-heal.js";
import { clusterIncidents, incidentsPath, readIncidents, recordIncident } from "../src/skills/incidents.js";
import { LookoutError } from "../src/types.js";
import { SUITE_HOME } from "./setup.js";
import { tmpProject } from "./tmp-project.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

/** A throwaway git checkout that looks enough like lookout's own to heal. */
function checkout(gatesPass = false): string {
  const dir = mkdtempSync(join(tmpdir(), "lookout-heal-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".changeset"), { recursive: true });
  writeFileSync(join(dir, "src", "thing.ts"), "export const a = 1;\n");
  // lookout's own state lives in the checkout's `.lookout/` now (the incident
  // log here, the heals and attempts next). Unignored, the first incident this
  // fixture records would make `git status` dirty and self-heal would refuse
  // to run over what it thinks is somebody's work in progress.
  writeFileSync(join(dir, ".gitignore"), ".lookout/\n");
  if (gatesPass) {
    // Gates that succeed, so the accepting path can be exercised without
    // standing up a whole toolchain in a temp directory.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { typecheck: "true", lint: "true", build: "true" } }),
    );
    writeFileSync(join(dir, "ok.test.ts"), 'import { test, expect } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n');
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return dir;
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "lookout-home-"));
  process.env.LOOKOUT_HOME = dir;
  return dir;
}

/** A checkout, and lookout pointed at it: where a no-project failure lands. */
function tmpCheckout(): string {
  const dir = checkout();
  process.env.LOOKOUT_CHECKOUT = dir;
  return dir;
}

afterEach(() => {
  // Back to the suite's throwaway home rather than deleted: an unset
  // LOOKOUT_HOME is the operator's real one, and every test that ran after this
  // file would append its incidents there.
  process.env.LOOKOUT_HOME = SUITE_HOME;
  delete process.env.LOOKOUT_CHECKOUT;
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_HEAL_FILE;
});

describe("the incident log", () => {
  test("outlives a run, unlike the event log, in the project it happened in", () => {
    const p = tmpProject("lookout-incidents-").projectDir;
    writeFileSync(join(p, "lookout.config.json"), '{"targets":[]}');
    recordIncident({ at: "t1", kind: "crash", message: "boom", project: p });
    recordIncident({ at: "t2", kind: "operator-error", message: "no config", project: p });
    expect(readIncidents(p).map((i) => i.kind)).toEqual(["crash", "operator-error"]);
    expect(existsSync(incidentsPath(p))).toBe(true);
  });

  test("a failure with no configured project in scope goes to lookout's own checkout", () => {
    const checkout = tmpCheckout();
    const bare = mkdtempSync(join(tmpdir(), "lookout-bare-"));
    recordIncident({ at: "t1", kind: "crash", message: "boom", project: bare });
    // Not in the directory it happened in: that directory has no lookout
    // config, and littering one with a `.lookout/` is what this avoids.
    expect(existsSync(join(bare, ".lookout"))).toBe(false);
    expect(readIncidents(checkout).map((i) => i.message)).toEqual(["boom"]);
  });

  test("and nowhere at all when there is no checkout either", () => {
    process.env.LOOKOUT_CHECKOUT = mkdtempSync(join(tmpdir(), "lookout-installed-"));
    const bare = mkdtempSync(join(tmpdir(), "lookout-bare-"));
    expect(() => recordIncident({ at: "t", kind: "crash", message: "boom", project: bare })).not.toThrow();
    expect(existsSync(join(bare, ".lookout"))).toBe(false);
  });

  test("groups occurrences of one failure by shape, not by wording", () => {
    // Paths and counts differ between occurrences of the same bug.
    const groups = clusterIncidents([
      { at: "t1", kind: "judge-rejected", message: "3 finding(s) rejected in /a/b" },
      { at: "t2", kind: "judge-rejected", message: "11 finding(s) rejected in /c/d" },
      { at: "t3", kind: "crash", message: "boom" },
    ]);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.kind).toBe("judge-rejected");
    expect(groups[1]!.count).toBe(1);
  });

  test("a log that cannot be written does not replace the failure it records", () => {
    process.env.LOOKOUT_CHECKOUT = "/proc/nonexistent-and-unwritable";
    expect(() => recordIncident({ at: "t", kind: "crash", message: "boom" })).not.toThrow();
  });
});

describe("what self-heal refuses", () => {
  test("an installed package: no source to fix, no repository to revert in", () => {
    process.env.LOOKOUT_CHECKOUT = mkdtempSync(join(tmpdir(), "lookout-installed-"));
    expect(ownCheckout()).toBeNull();
  });

  test("a checkout with uncommitted work in it", async () => {
    home();
    const dir = checkout();
    process.env.LOOKOUT_CHECKOUT = dir;
    writeFileSync(join(dir, "src", "wip.ts"), "// somebody is mid-edit\n");
    recordIncident({ at: "t", kind: "crash", message: "boom" });
    await expect(selfHeal({ positionals: [], flags: {} })).rejects.toThrow(LookoutError);
  });

  test("running while another heal holds the lock", () => {
    const dir = home();
    const lock = join(dir, "self-heal.lock");
    writeFileSync(lock, "now");
    expect(lockHeld(lock)).toBe(true);
    // An abandoned lock is not a lock: a healer that died must not wedge this
    // forever.
    expect(lockHeld(lock, Date.now() + 31 * 60_000)).toBe(false);
    expect(lockHeld(join(dir, "nothing.lock"))).toBe(false);
  });

  test("nothing to heal when nothing has gone wrong", async () => {
    home();
    process.env.LOOKOUT_CHECKOUT = checkout();
    expect(await selfHeal({ positionals: [], flags: {} })).toBe(0);
  });
});

describe("a change that fails a gate", () => {
  test("is reverted whole, kept for a person to read, and recorded", async () => {
    const h = home();
    const dir = checkout();
    process.env.LOOKOUT_CHECKOUT = dir;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    // The healer writes a real file; the fixture has no scripts, so the very
    // first gate fails. Any failing gate takes everything with it.
    process.env.MOCK_HEAL_FILE = join(dir, "src", "healed.ts");
    recordIncident({ at: "t", kind: "judge-unparseable", message: "judge reply was not parseable JSON" });

    expect(await selfHeal({ positionals: [], flags: {} })).toBe(1);

    // Nothing survived, including the untracked file.
    expect(existsSync(join(dir, "src", "healed.ts"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().trim()).toBe("");

    // The attempt is kept where somebody can read what was tried and why it
    // was refused.
    const attempts = readdirSync(join(h, "self-heal"));
    expect(attempts).toHaveLength(1);
    const kept = join(h, "self-heal", attempts[0]!);
    expect(existsSync(join(kept, "attempt.diff"))).toBe(true);
    expect(readFileSync(join(kept, "gates.txt"), "utf8")).toContain("typecheck");
    expect(readFileSync(join(kept, "report.json"), "utf8")).toContain("Retry the judge");

    // And the rollback is itself an incident: a healer that keeps failing the
    // same way is a thing worth seeing.
    expect(readIncidents(dir).map((i) => i.kind)).toContain("self-heal-rollback");

    // The commit it would have made was never made.
    expect(execFileSync("git", ["log", "--oneline"], { cwd: dir }).toString().trim().split("\n")).toHaveLength(1);
  });
});

describe("a change that passes every gate", () => {
  test("is kept, committed alone with a patch changeset, and never pushed", async () => {
    home();
    const dir = checkout(true);
    process.env.LOOKOUT_CHECKOUT = dir;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_HEAL_FILE = join(dir, "src", "healed.ts");
    recordIncident({ at: "t", kind: "judge-unparseable", message: "judge reply was not parseable JSON" });

    expect(await selfHeal({ positionals: [], flags: {} })).toBe(0);

    expect(existsSync(join(dir, "src", "healed.ts"))).toBe(true);
    // Committed, so the tree is clean and one `git revert` undoes all of it.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().trim()).toBe("");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: dir }).toString().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("Retry the judge");

    // A patch, always: a fix to lookout's own behaviour is not a new
    // capability, and nothing here may spend a minor on one.
    const changesets = readdirSync(join(dir, ".changeset"));
    expect(changesets).toHaveLength(1);
    const changeset = readFileSync(join(dir, ".changeset", changesets[0]!), "utf8");
    expect(changeset).toContain('"@nannier-com/lookout": patch');
    expect(changeset).not.toContain("minor");
  });
});

// The forfeit and the pick: a reply that breaks the contract loses its
// edits, and the prompt carries exactly one incident group.
describe("the reply contract is load-bearing", () => {
  test("an unparseable healer reply is reverted, recorded, and exits 1", async () => {
    const dir = checkout();
    const h = home();
    // The checkout first: a failure with no project in scope is recorded
    // against lookout's own checkout, so which one is current decides where
    // this seeded incident lands.
    process.env.LOOKOUT_CHECKOUT = dir;
    recordIncident({ at: new Date().toISOString(), kind: "crash", message: "boom in module 7", verb: "check" });
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_HEAL_FILE = join(dir, "src", "healed.ts");
    process.env.MOCK_HEAL_GARBAGE = "1";
    try {
      const code = await selfHeal({ positionals: [], flags: {} });
      expect(code).toBe(1);
      // The edit is gone, nothing was committed, and the failure is durable.
      expect(existsSync(join(dir, "src", "healed.ts"))).toBe(false);
      const log = execFileSync("git", ["log", "--oneline"], { cwd: dir }).toString();
      expect(log.trim().split("\n")).toHaveLength(1);
      expect(readFileSync(incidentsPath(dir), "utf8")).toContain("healer-unparseable");
      // The raw reply is kept for a person.
      const attempts = readdirSync(join(h, "self-heal"));
      expect(attempts).toHaveLength(1);
      expect(readFileSync(join(h, "self-heal", attempts[0]!, "raw-reply.txt"), "utf8")).toContain("trust me");
    } finally {
      delete process.env.MOCK_HEAL_GARBAGE;
    }
  });

  test("the prompt carries exactly one incident group, the heaviest active one", async () => {
    const dir = checkout(true);
    home();
    process.env.LOOKOUT_CHECKOUT = dir;
    for (let i = 0; i < 3; i++) {
      recordIncident({ at: new Date().toISOString(), kind: "crash", message: `heavy bug ${i}`, verb: "check" });
    }
    recordIncident({ at: new Date().toISOString(), kind: "judge-unparseable", message: "light bug", verb: "check" });
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_HEAL_FILE = join(dir, "src", "healed.ts");
    const argvFile = join(dir, "argv.jsonl");
    process.env.MOCK_ARGV_FILE = argvFile;
    try {
      expect(await selfHeal({ positionals: [], flags: {} })).toBe(0);
      const prompt = (JSON.parse(readFileSync(argvFile, "utf8").trim().split("\n")[0]!) as string[])[1]!;
      expect(prompt.match(/^\d+\. \[/gm)).toHaveLength(1);
      expect(prompt).toContain("heavy bug");
      expect(prompt).not.toContain("light bug");
    } finally {
      delete process.env.MOCK_ARGV_FILE;
    }
  });

  test("a committed heal is marked, so the settled group stops being offered", async () => {
    const dir = checkout(true);
    const h = home();
    // The checkout first: a failure with no project in scope is recorded
    // against lookout's own checkout, so which one is current decides where
    // this seeded incident lands.
    process.env.LOOKOUT_CHECKOUT = dir;
    recordIncident({ at: new Date().toISOString(), kind: "crash", message: "boom in module 7", verb: "check" });
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_HEAL_FILE = join(dir, "src", "healed.ts");
    expect(await selfHeal({ positionals: [], flags: {} })).toBe(0);
    expect(readFileSync(join(h, "heals.jsonl"), "utf8")).toContain("boom in module N");
    // No new occurrences since the heal: the next run finds nothing active.
    const again = await selfHeal({ positionals: [], flags: {} });
    expect(again).toBe(0);
  });
});
