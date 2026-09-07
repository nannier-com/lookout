/**
 * What the project declared, as the refuter is shown it.
 *
 * The judge panels see a project's never-file lines through the rubric's
 * extensions slot; the refuter never did, so a taste finding that re-litigated
 * an excused choice reached it with nothing saying the choice was excused. This
 * is the refuter's copy: the never-file lines as bullets and, once a project
 * declares one, its design direction, under the refute skill's own heading.
 */

export interface LoadedDirection {
  /** The config-relative spelling of where it came from, never an absolute path. */
  source: string;
  text: string;
}

/** The refuter's "What the project declared" section, or "" when nothing is. */
export function declaredBlock(
  neverFile: readonly string[] | undefined,
  direction: LoadedDirection | null,
): string {
  const parts: string[] = [];
  if (neverFile && neverFile.length > 0) {
    parts.push("Never-file rules:\n" + neverFile.map((l) => `- ${l}`).join("\n"));
  }
  if (direction) {
    parts.push(`Declared direction (${direction.source}):\n${direction.text.trim()}`);
  }
  return parts.join("\n\n");
}
