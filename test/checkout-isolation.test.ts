/**
 * The suite is not allowed to write into lookout's own checkout.
 *
 * This is a guard, not a feature test, and it replaces the one that kept the
 * suite out of the operator's home directory, which no longer exists. The
 * failure it exists to catch is silent: a failure with no configured project
 * in scope is recorded against lookout's checkout, so a test that records one
 * appends an invented incident to the repository it is running from, where
 * `lookout doctor` and the learning area of `lookout ui` will show it to
 * whoever works here next. Nothing else in the suite would notice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ownCheckout } from "../src/checkout.js";
import { incidentsPath, recordIncident } from "../src/skills/incidents.js";
import { SUITE_CHECKOUT } from "./setup.js";
import { tmpProject } from "./tmp-project.js";

/** The repository this suite is running from: the one it must not write to. */
const REAL_CHECKOUT = join(import.meta.dir, "..");

afterEach(() => {
  process.env.LOOKOUT_CHECKOUT = SUITE_CHECKOUT;
});

describe("where a test run keeps lookout's own state", () => {
  test("a throwaway checkout, never the repository under test", () => {
    expect(ownCheckout()).toBe(SUITE_CHECKOUT);
    expect(ownCheckout()).not.toBe(REAL_CHECKOUT);
  });

  test("a test that clears the variable", () => {
    // What a teardown does when it tidies up after itself. The next test is
    // the assertion: the preload's hook has to put the suite checkout back
    // before anything can record an incident into this repository's log.
    delete process.env.LOOKOUT_CHECKOUT;
    expect(process.env.LOOKOUT_CHECKOUT).toBeUndefined();
  });

  test("does not hand the next one the repository it is running from", () => {
    expect(process.env.LOOKOUT_CHECKOUT).toBe(SUITE_CHECKOUT);
    expect(ownCheckout()).toBe(SUITE_CHECKOUT);
  });

  test("an incident with no project lands in the suite's checkout, not this one", () => {
    const bare = mkdtempSync(join(tmpdir(), "lookout-bare-"));
    recordIncident({ at: "t", kind: "crash", message: "a test invented this", project: bare });
    expect(readFileSync(incidentsPath(SUITE_CHECKOUT), "utf8")).toContain("a test invented this");
    expect(existsSync(join(bare, ".lookout"))).toBe(false);
  });

  test("a project's own state is inside it, and under no home directory", () => {
    const r = tmpProject("lookout-guard-");
    expect(incidentsPath(r.projectDir)).toBe(join(r.projectDir, ".lookout", "incidents.jsonl"));
    expect(incidentsPath(r.projectDir).startsWith(join(homedir(), ".lookout"))).toBe(false);
  });

  test("is only redirected for everything when bun is run from the repository root", () => {
    // bunfig.toml is read from the working directory and nowhere else: a run
    // started somewhere else silently loses the preload, and with it every test
    // file that does not import the setup module itself. Better to fail here
    // than to find out from an incident log in someone's checkout.
    const config = join(process.cwd(), "bunfig.toml");
    // The working directory goes into the assertion so a failure names the
    // place the run was started from rather than just a missing file.
    const preloads = existsSync(config) ? readFileSync(config, "utf8") : `no bunfig.toml in ${process.cwd()}`;
    expect(preloads).toContain("./test/setup.ts");
  });

  // `Incident.project` is documented absolute, and `incidentLogDir` used to
  // trust that: it handed whatever it was given to `locateConfig`, which
  // resolves against the working directory and climbs. A display name such as
  // "p" therefore found the config of whichever repository the process stood
  // in and logged there, walking straight past LOOKOUT_CHECKOUT. Two of the
  // self-heal tests fail from exactly this the moment a lookout.config.ts is
  // left at this repository's root, which serving lookout's own checkout in
  // `lookout ui` does by design.
  test("a display name is not a project, and never steers the log into the working directory", () => {
    const trap = tmpProject("lookout-trap-");
    const before = process.cwd();
    process.chdir(trap.projectDir);
    try {
      recordIncident({ at: "t", kind: "crash", message: "steered by a display name", project: "p" });
    } finally {
      process.chdir(before);
    }
    expect(readFileSync(incidentsPath(SUITE_CHECKOUT), "utf8")).toContain("steered by a display name");
    expect(existsSync(incidentsPath(trap.projectDir))).toBe(false);
  });

  test("an absolute path to a configured project is still that project's own log", () => {
    // The guard is a floor, not a ceiling: the primary path, a real directory
    // naming a real project, must keep landing in that project.
    const r = tmpProject("lookout-abs-");
    recordIncident({ at: "t", kind: "crash", message: "addressed by directory", project: r.projectDir });
    expect(readFileSync(incidentsPath(r.projectDir), "utf8")).toContain("addressed by directory");
  });
});
