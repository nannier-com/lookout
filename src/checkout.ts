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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOKOUT_DIR } from "./config-locate.js";

export function ownCheckout(): string | null {
  const root = process.env.LOOKOUT_CHECKOUT ?? fileURLToPath(new URL("..", import.meta.url));
  return existsSync(join(root, "src")) && existsSync(join(root, ".git")) ? root : null;
}

/** lookout's own `.lookout/`, the way a judged project has one. */
export function checkoutStateDir(checkout: string): string {
  return join(checkout, LOOKOUT_DIR);
}
