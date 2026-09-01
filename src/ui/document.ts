/**
 * Serving one issue's own document to the browser.
 *
 * The board has always printed the folder an issue lives in, which is the right
 * thing to hand somebody at a terminal and no use at all to somebody at the
 * page: a `file://` link written into an `http://` document is refused by every
 * browser, so the only way to read `Issue.md` from a card is for this server to
 * hand it over.
 *
 * A read and nothing else. The document is written when the backlog is saved,
 * and lookout does not write on a GET, so an issue whose folder was never
 * materialised has nothing to serve here. The card is told that instead of
 * being given a link that answers 404.
 */
import type { ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { ISSUE_DOC_FILE, issueDocPath } from "../issues/paths.js";
import { MIME } from "./http.js";
import type { ResolvedConfig } from "../types.js";

/**
 * `/issue/418203/Issue.md`, and nothing else that looks like it.
 *
 * Six digits and that one name. An issue id is always six digits, so this is an
 * allowlist rather than a check for "..", exactly like the one guarding the
 * page's own assets and for the same reason: a browser can spell traversal
 * several ways and cannot spell it as a number.
 */
const ISSUE_URL = /^\/issue\/(\d{6})\/([^/]+)$/;

/**
 * Where the document for this URL actually is, or null when nothing answers.
 *
 * Separate from serving it because that is the half worth testing: which URLs
 * resolve to a file, which resolve to nothing, and that neither answer depends
 * on how the browser spelled the path.
 */
export function issueDocFile(resolved: ResolvedConfig, pathname: string): string | null {
  const m = ISSUE_URL.exec(pathname);
  if (!m || m[2] !== ISSUE_DOC_FILE) return null;
  // Asked of the disk: `issueDocPath` follows the issue into the archive when
  // it has been filed away, and a filed-away issue's document is still the
  // document.
  const p = issueDocPath(resolved, m[1]!);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

/** The document, streamed as it is on disk. */
export function serveIssueDoc(
  res: ServerResponse,
  resolved: ResolvedConfig,
  pathname: string,
): void {
  const file = issueDocFile(resolved, pathname);
  if (!file) {
    // Say what is missing rather than "not found". An issue with no document is
    // an issue whose folder was never written, and that is worth reading in a
    // browser tab instead of guessing at from a bare 404.
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`lookout has no ${ISSUE_DOC_FILE} for that issue`);
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[".md"]!,
    // Rewritten on every backlog save, so a cached copy is a stale account of
    // an issue somebody may be in the middle of fixing.
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}
