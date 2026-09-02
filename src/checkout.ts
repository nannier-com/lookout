/**
 * lookout's own checkout, when it is running from one.
 *
 * lookout writes about two things: the project it is judging, whose record
 * lives in that project's `.lookout/`, and itself, which is the code in this
 * file's own repository. The second kind has to land somewhere, and the only
 * honest somewhere is the checkout it describes: a failure of lookout is not
 * a judged project's business, and it is not the operator's home's either now
 * that there is no home.
 *
 * A published install has no source to fix and no repository to revert in, so
 * this answers null there and every caller degrades rather than inventing a
 * directory. `LOOKOUT_CHECKOUT` overrides it, which is how a test points this
 * at a fixture instead of at the repository it is running from.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOKOUT_DIR } from "./config-locate.js";

export function ownCheckout(): string | null {
  // Resolved, because `fileURLToPath` of a directory URL keeps its trailing
  // slash: two spellings of one checkout would dedupe as two incident sources
  // and print with a stray separator wherever the path is shown.
  const root = resolve(process.env.LOOKOUT_CHECKOUT ?? fileURLToPath(new URL("..", import.meta.url)));
  return existsSync(join(root, "src")) && existsSync(join(root, ".git")) ? root : null;
}

/** lookout's own `.lookout/`, the way a judged project has one. */
export function checkoutStateDir(checkout: string): string {
  return join(checkout, LOOKOUT_DIR);
}

/**
 * Everything `self-heal` writes about itself, beside the source it changed.
 *
 * The lock belongs here for the reason it exists: two heals in one checkout
 * revert each other's work and commit the result, so what it guards is a
 * checkout, and a lock kept anywhere else would be guarding the wrong thing.
 * The heals belong here because a heal is a commit in this repository and a
 * fix to shared code is settled for every project that runs it. The attempts
 * belong here because they are the diff that was reverted out of this tree.
 */
export function selfHealDir(checkout: string): string {
  return join(checkoutStateDir(checkout), "self-heal");
}

export function healsPath(checkout: string): string {
  return join(selfHealDir(checkout), "heals.jsonl");
}

export function selfHealLockPath(checkout: string): string {
  return join(selfHealDir(checkout), "lock");
}

/** Where one reverted attempt is kept, so a person can read what was tried. */
export function attemptDir(checkout: string, stamp: string): string {
  return join(selfHealDir(checkout), "attempts", stamp);
}

/** The attempts directory itself, for the page that lists them. */
export function attemptsDir(checkout: string): string {
  return join(selfHealDir(checkout), "attempts");
}
