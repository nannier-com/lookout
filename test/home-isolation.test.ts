/**
 * The suite is not allowed to write into the operator's home.
 *
 * This is a guard, not a feature test. The failure it exists to catch is
 * silent: state a test wrote lands where `lookout ui` reads it, so the only
 * symptom is an operator being shown something that never happened to them,
 * long after the run that wrote it. Nothing else in the suite would notice.
 *
 * The incident log has left the home for the project it happened in, so the
 * guard's first assertion now covers what replaced it; the heals, the
 * self-heal attempts and the ui's settings are still here, and still guarded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { incidentsPath } from "../src/skills/incidents.js";
import { lookoutHome } from "../src/home.js";
import { SUITE_HOME } from "./setup.js";
import { tmpProject } from "./tmp-project.js";

const OPERATOR_HOME = join(homedir(), ".lookout");

afterEach(() => {
  process.env.LOOKOUT_HOME = SUITE_HOME;
});

describe("where a test run keeps lookout's home", () => {
  test("a throwaway directory, never the operator's", () => {
    expect(lookoutHome()).toBe(SUITE_HOME);
    expect(lookoutHome()).not.toBe(OPERATOR_HOME);
  });

  // Was an assertion that the incident log was not under the home directory,
  // back when one file held every project's. The log is per project now, so
  // what has to be true is that it is inside the project it belongs to.
  test("an incident log is inside its own project, not under any home", () => {
    const r = tmpProject("lookout-guard-");
    expect(incidentsPath(r.projectDir)).toBe(join(r.projectDir, ".lookout", "incidents.jsonl"));
    expect(incidentsPath(r.projectDir).startsWith(homedir() + "/")).toBe(false);
    expect(incidentsPath(r.projectDir).startsWith(lookoutHome())).toBe(false);
  });

  test("a test that clears the variable", () => {
    // What a teardown does when it tidies up after itself. The next test is
    // the assertion: the preload's hook has to put the suite home back before
    // anything can record an incident into the operator's log.
    delete process.env.LOOKOUT_HOME;
    expect(process.env.LOOKOUT_HOME).toBeUndefined();
  });

  test("does not hand the next one the operator's real home", () => {
    expect(process.env.LOOKOUT_HOME).toBe(SUITE_HOME);
    expect(lookoutHome()).toBe(SUITE_HOME);
  });

  test("a test that points the home at the operator's own", () => {
    process.env.LOOKOUT_HOME = OPERATOR_HOME;
    expect(process.env.LOOKOUT_HOME).toBe(OPERATOR_HOME);
  });

  test("does not leave it pointed there either", () => {
    expect(lookoutHome()).toBe(SUITE_HOME);
  });

  test("is only redirected for everything when bun is run from the repository root", () => {
    // bunfig.toml is read from the working directory and nowhere else: a run
    // started somewhere else silently loses the preload, and with it every test
    // file that does not import the setup module itself. Better to fail here
    // than to find out from an operator's incident log.
    const config = join(process.cwd(), "bunfig.toml");
    // The working directory goes into the assertion so a failure names the
    // place the run was started from rather than just a missing file.
    const preloads = existsSync(config) ? readFileSync(config, "utf8") : `no bunfig.toml in ${process.cwd()}`;
    expect(preloads).toContain("./test/setup.ts");
  });
});
