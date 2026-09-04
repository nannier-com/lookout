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
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ownCheckout } from "../src/checkout.js";
import { incidentLogDir, incidentsPath, recordIncident } from "../src/skills/incidents.js";
import { SUITE_CHECKOUT } from "./setup.js";
import { tmpProject } from "./tmp-project.js";

/** The repository this suite is running from: the one it must not write to. */
const REAL_CHECKOUT = join(import.meta.dir, "..");

/**
 * Run something from inside a directory, and put the old one back.
 *
 * Realpathed, because `process.chdir` reports the resolved path and macOS
 * spells the temp directory both ways.
 */
function inDir<T>(dir: string, fn: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

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

  test("a display name for a project cannot steer the log into the repository underfoot", () => {
    // The hole this closes: `Incident.project` is a directory, but a display
    // name is a string too, and `locateConfig` resolves a relative one against
    // the working directory and climbs. Standing in ANY configured repository
    // — and lookout's own checkout is one, because `lookout ui` writes a
    // config at its root by design — a `project` of "p" named that repository
    // and the incident was appended to its log. LOOKOUT_CHECKOUT does not
    // cover it: the redirect guards the no-project fallback, and a configured
    // project beats the fallback, so this was the one route by which the suite
    // could write into the repository it is testing. It did: six invented
    // contract failures per run, from test/reply.test.ts.
    const standing = realpathSync(tmpProject("lookout-underfoot-").projectDir);
    inDir(standing, () => {
      expect(incidentLogDir("p")).toBe(SUITE_CHECKOUT);
      recordIncident({ at: "t", kind: "crash", message: "a display name invented this", project: "p" });
    });
    expect(existsSync(incidentsPath(standing))).toBe(false);
    expect(readFileSync(incidentsPath(SUITE_CHECKOUT), "utf8")).toContain("a display name invented this");
  });

  test("but its directory still does, which is what the field is for", () => {
    // The guard discriminates on being a path, not on being a stranger: the
    // same project, named the way the contract asks, keeps its own failures.
    const standing = realpathSync(tmpProject("lookout-underfoot-").projectDir);
    inDir(standing, () => {
      expect(incidentLogDir(standing)).toBe(standing);
      recordIncident({ at: "t", kind: "crash", message: "a directory invented this", project: standing });
    });
    expect(readFileSync(incidentsPath(standing), "utf8")).toContain("a directory invented this");
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
});
