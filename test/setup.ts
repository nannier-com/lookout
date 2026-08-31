/**
 * What the whole suite gets before its first test file loads.
 *
 * lookout keeps its incident log, its ui settings and its self-heal attempts
 * under the operator's home, pooled across every project on the machine. That
 * is right for the tool and wrong for its tests: a run that exercised judge
 * ingestion appended real-looking failures to the real log, and the learning
 * area of `lookout ui` then showed the operator a page of things that had gone
 * wrong with lookout, none of which had ever happened to them.
 *
 * Pointing LOOKOUT_HOME at a throwaway directory here, once, is what makes that
 * impossible rather than merely unlikely. A test that remembers to redirect the
 * home is only as good as the next test that forgets.
 */
import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The one directory the suite must never write to. */
const OPERATOR_HOME = join(homedir(), ".lookout");

/** The home every test uses unless it deliberately makes one of its own. */
export const SUITE_HOME = mkdtempSync(join(tmpdir(), "lookout-suite-home-"));

process.env.LOOKOUT_HOME = SUITE_HOME;

/**
 * Put the suite home back when a test has cleared it.
 *
 * Tests that want a home of their own set LOOKOUT_HOME and tear it down again,
 * and a teardown that deletes the variable hands every later test in the process
 * the operator's real home. Only a missing or dangerous value is replaced, so a
 * test that has deliberately pointed somewhere else keeps what it chose.
 */
beforeEach(() => {
  const current = process.env.LOOKOUT_HOME;
  if (current === undefined || current === OPERATOR_HOME) process.env.LOOKOUT_HOME = SUITE_HOME;
});

afterAll(() => {
  rmSync(SUITE_HOME, { recursive: true, force: true });
});
