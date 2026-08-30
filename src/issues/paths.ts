/**
 * Where an issue's material lives. Paths only, so the document, the store and
 * the attempt log can each name the folder without importing each other.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lookoutDir } from "../config.js";
import type { ResolvedConfig } from "../types.js";

export function issuesDir(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "issues");
}

/**
 * Where filed-away issues go.
 *
 * A subfolder rather than a sibling directory, so `.lookout/issues/` remains
 * the one place issues live and nothing has to be told about a second root.
 * Safe as a name because an issue id is always six digits.
 */
export const ISSUE_ARCHIVE_DIR = "archive";

export function issueArchiveDir(resolved: ResolvedConfig, id: string): string {
  return join(issuesDir(resolved), ISSUE_ARCHIVE_DIR, id);
}

/** The folder an issue belongs in, given whether it has been filed away. */
export function issueDirFor(resolved: ResolvedConfig, id: string, archived: boolean): string {
  return archived ? issueArchiveDir(resolved, id) : join(issuesDir(resolved), id);
}

/**
 * Where this issue's folder actually is.
 *
 * Asked of the disk rather than of the record, because every caller here has an
 * id and only some of them have the backlog open. The record decides where a
 * folder belongs and the save moves it; this answers where it is right now,
 * which is what somebody about to open a file needs.
 */
export function issueDir(resolved: ResolvedConfig, id: string): string {
  const archived = issueArchiveDir(resolved, id);
  return existsSync(archived) ? archived : join(issuesDir(resolved), id);
}

export function issueImgDir(resolved: ResolvedConfig, id: string): string {
  return join(issueDir(resolved, id), "img");
}

/**
 * The generated pair inside the folder, named here so every writer and reader
 * spells them identically; the capitalisation is deliberate and load-bearing,
 * because the rename from the old lowercase names is case-only and must be
 * matched byte-exactly (see migrateLegacyLayout in store.ts).
 */
export const ISSUE_RECORD_FILE = "Issue.json";
export const ISSUE_DOC_FILE = "Issue.md";

export function issueRecordPath(resolved: ResolvedConfig, id: string): string {
  return join(issueDir(resolved, id), ISSUE_RECORD_FILE);
}

export function issueDocPath(resolved: ResolvedConfig, id: string): string {
  return join(issueDir(resolved, id), ISSUE_DOC_FILE);
}

/** `web/app/root/rest--desktop-dark.png` -> `web-app-root-rest--desktop-dark.png`. */
export function flatShotName(evidenceRelPath: string): string {
  return evidenceRelPath.split(/[\\/]/).join("-");
}
