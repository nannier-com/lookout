/**
 * What the whole suite gets before its first test file loads.
 *
 * Two directories a test must never write into, for the same reason: a run
 * that exercised judge ingestion appended real-looking failures to a log the
 * learning area of `lookout ui` reads, and the operator was shown a page of
 * things that had gone wrong with lookout, none of which had ever happened to
 * them.
 *
 * The first is the operator's home, which still holds the heals, the self-heal
 * attempts and the ui's settings. The second is lookout's own checkout: an
 * incident whose project has no lookout config is recorded against the
 * checkout now, and without this the suite would append its fabricated
 * failures to the repository it is running from. Both are pointed at throwaway
 * directories here, once, which is what makes it impossible rather than merely
 * unlikely: a test that remembers to redirect is only as good as the next test
 * that forgets.
 */
import { afterAll, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The one directory the suite must never write to. */
const OPERATOR_HOME = join(homedir(), ".lookout");

/** The home every test uses unless it deliberately makes one of its own. */
export const SUITE_HOME = mkdtempSync(join(tmpdir(), "lookout-suite-home-"));

/**
 * A checkout every test uses instead of the repository it is running from.
 *
 * `ownCheckout` recognises a directory by `src/` beside `.git/`, so the
 * stand-in carries both; nothing here runs git beyond `init`, and a test that
 * needs a healable checkout still builds its own.
 */
export const SUITE_CHECKOUT = mkdtempSync(join(tmpdir(), "lookout-suite-checkout-"));
mkdirSync(join(SUITE_CHECKOUT, "src"), { recursive: true });
writeFileSync(join(SUITE_CHECKOUT, ".gitignore"), ".lookout/\n");
execFileSync("git", ["init", "-q"], { cwd: SUITE_CHECKOUT, stdio: "pipe" });

process.env.LOOKOUT_HOME = SUITE_HOME;
process.env.LOOKOUT_CHECKOUT = SUITE_CHECKOUT;

/**
 * Put the suite's home and checkout back when a test has cleared them.
 *
 * Tests that want one of their own set the variable and tear it down again,
 * and a teardown that deletes it hands every later test in the process the
 * operator's real home, or this repository. Only a missing or dangerous value
 * is replaced, so a test that has deliberately pointed somewhere else keeps
 * what it chose.
 */
beforeEach(() => {
  const home = process.env.LOOKOUT_HOME;
  if (home === undefined || home === OPERATOR_HOME) process.env.LOOKOUT_HOME = SUITE_HOME;
  if (process.env.LOOKOUT_CHECKOUT === undefined) process.env.LOOKOUT_CHECKOUT = SUITE_CHECKOUT;
});

afterAll(() => {
  rmSync(SUITE_HOME, { recursive: true, force: true });
  rmSync(SUITE_CHECKOUT, { recursive: true, force: true });
});
