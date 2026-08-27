/**
 * Where an issue's material lives. Paths only, so the document, the store and
 * the attempt log can each name the folder without importing each other.
 */
import { join } from "node:path";
import { lookoutDir } from "../config.js";
import type { ResolvedConfig } from "../types.js";

export function issuesDir(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "issues");
}

export function issueDir(resolved: ResolvedConfig, id: string): string {
  return join(issuesDir(resolved), id);
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
