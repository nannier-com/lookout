/**
 * The page's markup, and why it is read rather than compiled in.
 *
 * This was a template literal exported as a constant, which meant the server
 * held the entire page from the moment it started. Every other page asset is
 * read off disk per request and sent with `no-store`, on the stated grounds
 * that a rebuild during a fix session has to reach the open tab on a reload.
 * The shell was the one part that did not, and the gap stayed invisible until
 * it mattered: splitting `app.css` into `shell.css` and `board.css` left a
 * running server asking for a file the rebuild had deleted, so the page came
 * back completely unstyled while the checkout, the build, the type check, the
 * linter and the tests were all correct and green. That is the worst shape a
 * bug can take, because every instrument says to go looking in the one place
 * nothing is wrong.
 *
 * Reading it per request closes that. The markup is static, the file is a few
 * kilobytes off local disk, and a stylesheet rename now reaches an open tab on
 * a reload exactly as an edit to `board.css` always did.
 *
 * It sits beside the stylesheets in `client/` because `clientDir()` already
 * answers for both a checkout and an install, so the shell needs no path logic
 * of its own and the build copies it exactly as it copies them. Being a real
 * `.html` file rather than a string also puts it where an editor can lint and
 * format it, which the template literal never allowed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientDir } from "./assets.js";
import { text } from "./http.js";

/** The shell as it is on disk right now, not as it was when the server started. */
export function pageHtml(): string {
  return readFileSync(join(clientDir(), "shell.html"), "utf8");
}

/**
 * The shell, or an explanation of why there isn't one.
 *
 * A shell the build forgot to copy is a blank screen, and a blank screen is the
 * hardest kind of failure to diagnose. This says which file is missing instead,
 * the same answer a missing stylesheet already gets.
 */
export function servePage(): Response {
  let html: string;
  try {
    html = pageHtml();
  } catch (e) {
    return text(500, `lookout could not read its page shell: ${(e as Error).message}`);
  }
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
