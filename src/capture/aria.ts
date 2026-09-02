/**
 * The accessibility tree beside a shot, and the shape lookout keeps of it.
 *
 * The integrity panel is asked to rule on a control missing an expected part:
 * a dialog with no dismiss affordance, a form field whose label is absent. From
 * pixels alone that is an inference, and the rubric is right that a model
 * reading an image cannot measure. The tree is not an image. It says what the
 * browser exposed: every meaningful element as a role, its accessible name and,
 * for some controls, its state. A label the page really does have is a fact
 * there, whatever the pixels made of it.
 *
 * It is evidence about what EXISTS, never about how anything looks, which is
 * why only two panels are given it and why its own skill prose says so. A role
 * missing from the tree is a matter for the accessibility scan, not for a judge.
 *
 * The trimming is here rather than in the browser so it is pure and tested.
 * Truncation is marked in the text itself, not only in the record: the model
 * reads the text, and a tree silently cut short would read as a complete
 * account of a page that has more in it.
 */
import { sha256 } from "../util.js";

export const ARIA_VERSION = 1;

/** Lines kept on disk: enough to reconstruct what the judge was shown, and more. */
export const MAX_STORED_LINES = 300;
/** Lines given to the judge. A batch carries several shots and the images too. */
export const MAX_PROMPT_LINES = 120;
/** A single line's cap: a long accessible name is a name, not a document. */
export const MAX_LINE_CHARS = 160;
/** Runs of plain text longer than this are collapsed; a wall of copy is not structure. */
export const MAX_TEXT_RUN = 3;

const NOTE =
  "The page's accessibility tree at the moment of the screenshot, as Playwright's " +
  "ariaSnapshot reports it. Evidence about what exists, never about how it looks.";

export interface AriaSidecar {
  version: number;
  note: string;
  shotId: string;
  runId: string;
  capturedAt: string;
  /** sha256 of the PNG this describes, for drift detection. */
  shotHash: string;
  origin: "document" | "element";
  /** The selector the tree was taken of, when the shot frames one element. */
  scope: string | null;
  /** sha256 of `yaml`, which is what the ledger keys on. */
  hash: string;
  lines: number;
  truncated: boolean;
  yaml: string;
}

/** The marker a cut tree ends with, so nothing it omits reads as absent. */
export function truncationLine(remaining: number): string {
  return `# ... ${remaining} more line(s) not shown`;
}

/**
 * Trim a tree to a line budget.
 *
 * Long lines are cut, runs of plain text are collapsed to their first few, and
 * whatever is still over the budget is dropped with the count said in the text.
 */
export function trimAria(yaml: string, maxLines: number): { yaml: string; lines: number; truncated: boolean } {
  const raw = yaml.split("\n");
  const kept: string[] = [];
  let run = 0;
  let collapsed = 0;
  for (const line of raw) {
    const isText = /^\s*- text:/.test(line);
    if (isText) {
      run += 1;
      if (run > MAX_TEXT_RUN) {
        collapsed += 1;
        continue;
      }
    } else {
      if (collapsed > 0) {
        kept.push(`${" ".repeat(indentOf(kept[kept.length - 1] ?? ""))}- text: ... (${collapsed} more)`);
        collapsed = 0;
      }
      run = 0;
    }
    kept.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line);
  }
  if (collapsed > 0) kept.push(`- text: ... (${collapsed} more)`);

  if (kept.length <= maxLines) {
    return { yaml: kept.join("\n"), lines: kept.length, truncated: false };
  }
  const head = kept.slice(0, maxLines - 1);
  head.push(truncationLine(kept.length - head.length));
  return { yaml: head.join("\n"), lines: head.length, truncated: true };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The sidecar as it is written beside the shot. */
export function buildAriaSidecar(
  yaml: string,
  shot: { id: string; runId: string; capturedAt: string; hash: string },
  scope: string | null,
): AriaSidecar {
  const trimmed = trimAria(yaml, MAX_STORED_LINES);
  return {
    version: ARIA_VERSION,
    note: NOTE,
    shotId: shot.id,
    runId: shot.runId,
    capturedAt: shot.capturedAt,
    shotHash: shot.hash,
    origin: scope ? "element" : "document",
    scope,
    hash: sha256(new TextEncoder().encode(trimmed.yaml)),
    lines: trimmed.lines,
    truncated: trimmed.truncated,
    yaml: trimmed.yaml,
  };
}

/** Read a sidecar back; null when absent, unreadable, or from another version. */
export function parseAriaSidecar(text: string): AriaSidecar | null {
  try {
    const parsed = JSON.parse(text) as AriaSidecar;
    return parsed.version === ARIA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** What the judge prompt carries for one shot: trimmed again, to the prompt's budget. */
export function promptTree(sidecar: AriaSidecar): string {
  return trimAria(sidecar.yaml, MAX_PROMPT_LINES).yaml;
}
