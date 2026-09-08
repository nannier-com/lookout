/**
 * What the whole suite gets before its first test file loads.
 *
 * One directory a test must never write into: lookout's own checkout. A
 * failure with no configured project in scope is recorded against the checkout
 * now, and without this the suite would append its fabricated failures to the
 * repository it is running from, where `lookout doctor` and the learning area
 * of `lookout ui` would show them to whoever works here next. That happened,
 * measured at 110KB of invented incidents on one run.
 *
 * It used to be the operator's home, redirected the same way and for the same
 * reason; there is no home any more, so this is what is left of that guard.
 * Pointing LOOKOUT_CHECKOUT at a throwaway checkout here, once, is what makes
 * it impossible rather than merely unlikely: a test that remembers to redirect
 * is only as good as the next test that forgets.
 */
import { afterAll, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectChangeListenerCount } from "../src/ui/session.js";

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

process.env.LOOKOUT_CHECKOUT = SUITE_CHECKOUT;

/**
 * Put the suite's checkout back when a test has cleared it.
 *
 * Tests that want a checkout of their own set the variable and tear it down
 * again, and a teardown that deletes it hands every later test in the process
 * this repository. Only a missing value is replaced, so a test that has
 * deliberately pointed somewhere else keeps what it chose.
 */
beforeEach(() => {
  if (process.env.LOOKOUT_CHECKOUT === undefined) process.env.LOOKOUT_CHECKOUT = SUITE_CHECKOUT;
});

afterAll(() => {
  rmSync(SUITE_CHECKOUT, { recursive: true, force: true });
});

/**
 * Nothing may still be subscribed to the project change when the suite ends.
 *
 * The whole suite is one process, so a module-level subscriber registered by
 * one file is still there for every file after it, and fires on THEIR
 * `setCurrentProject` calls. That is not a stale value a later test can reset:
 * it is live code from a finished file, running inside a stranger's test, on a
 * timer nobody awaits. It cost a gate half its runs -- a watcher that
 * `stopWatching` had closed came back on `test/ui-queue.test.ts`'s project
 * changes and handed off an issue in the middle of its assertions, so the
 * failure landed in a file that had done nothing wrong and moved every time.
 *
 * Checked once at the end rather than per file, which is the only hook a
 * preload gets: bun runs this after the last file, not after each one. So it
 * says a file leaked without saying which. To find it, run the suite's files
 * one at a time, or start from whatever `onProjectChange` was called and never
 * unsubscribed -- `startWatching` in `src/ui/watch.ts` is the only subscriber
 * lookout has, and `stopWatching` is what takes it back off.
 */
afterAll(() => {
  const left = projectChangeListenerCount();
  if (left > 0) {
    throw new Error(
      `${left} project-change subscriber(s) outlived the suite. A file started something `
      + "it never stopped, and it has been running inside every file since. See the note "
      + "in test/setup.ts.",
    );
  }
});
