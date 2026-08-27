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

export function issueShotsDir(resolved: ResolvedConfig, id: string): string {
  return join(issueDir(resolved, id), "shots");
}

/** `web/app/root/rest--desktop-dark.png` -> `web-app-root-rest--desktop-dark.png`. */
export function flatShotName(evidenceRelPath: string): string {
  return evidenceRelPath.split(/[\\/]/).join("-");
}
