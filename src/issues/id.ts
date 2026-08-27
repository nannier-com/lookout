/**
 * Issue ids: six digits, drawn at random, assigned once.
 *
 * An id is a handle a person types, says out loud, and names a folder with, so
 * it is short and uniform: exactly six digits, always, which reads the same as
 * a string, a number, a path segment or an argument. There is nothing to pad
 * and nothing to parse.
 *
 * Random rather than sequential because the number is a name, not a rank.
 * Sequential ids invite reading order and age into them ("issue 3 is older than
 * issue 47", "we are up to 200 defects"), and neither is true across projects
 * that share nothing but the tool.
 *
 * The draw happens ONCE per issue and is written to the backlog, because a
 * random id cannot be recomputed the way the old derived ids could. Everything
 * downstream (the folder, the handoff, `verify-fix --issue`) depends on it
 * staying put for as long as the issue exists.
 */
import { LookoutError } from "../types.js";

export const ISSUE_ID_MIN = 100000;
export const ISSUE_ID_MAX = 999999;

/** How many collisions to absorb before admitting the space is exhausted. */
const MAX_DRAWS = 50;

export function isIssueId(value: string): boolean {
  return /^[1-9][0-9]{5}$/.test(value);
}

/**
 * A six-digit id no one else in this project holds.
 *
 * `rng` is injectable so a test can force a collision; production passes
 * nothing and gets Math.random, which is the right tool for a name that needs
 * to be distinct rather than unguessable.
 */
export function mintIssueId(taken: ReadonlySet<string>, rng: () => number = Math.random): string {
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const span = ISSUE_ID_MAX - ISSUE_ID_MIN + 1;
    const id = String(ISSUE_ID_MIN + Math.floor(rng() * span));
    if (!taken.has(id)) return id;
  }
  throw new LookoutError(
    `could not find a free issue id after ${MAX_DRAWS} draws (${taken.size} in use)`,
    "six digits hold 900,000 issues; a project at that count needs archiving, not another id",
  );
}
