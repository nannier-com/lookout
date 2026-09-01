/**
 * The suite is not allowed to write into the operator's home.
 *
 * This is a guard, not a feature test. The failure it exists to catch is
 * silent: incidents recorded by a test land in the same append-only log the
 * learning area of `lookout ui` reads, so the only symptom is an operator being
 * shown failures that never happened to them, long after the run that wrote
 * them. Nothing else in the suite would notice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { incidentsPath } from "../src/skills/incidents.js";
import { lookoutHome } from "../src/home.js";
import { SUITE_HOME } from "./setup.js";

const OPERATOR_HOME = join(homedir(), ".lookout");

afterEach(() => {
  process.env.LOOKOUT_HOME = SUITE_HOME;
});

describe("where a test run keeps lookout's home", () => {
  test("a throwaway directory, never the operator's", () => {
    expect(lookoutHome()).toBe(SUITE_HOME);
    expect(lookoutHome()).not.toBe(OPERATOR_HOME);
    expect(incidentsPath().startsWith(homedir() + "/")).toBe(false);
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
