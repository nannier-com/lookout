/**
 * The board's wording where it departs from the document's.
 *
 * The record feed prints the same sentences the issue document does, so a
 * fixer recognises every line; the one difference is that a card has no room
 * for a forty-character commit, so shas are shortened the way `git log` does.
 */
export function shortShas(text: string): string {
  return text.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 7));
}
