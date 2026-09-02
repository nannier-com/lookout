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
 * A collapsed run of copy, marked so a second pass cannot mistake it for copy.
 *
 * The tree is trimmed twice: once to the stored budget and again to the smaller
 * prompt budget. The marker used to be spelled `- text: ...`, which the text-run
 * detector then matched, so the second pass counted its own marker as part of a
 * new run and replaced "(57 more)" with "(1 more)". Every count the judge read
 * was understated, in exactly the direction this file exists to prevent.
 */
function collapseLine(indent: number, dropped: number): string {
  return `${" ".repeat(indent)}# ... ${dropped} more text line(s) not shown`;
}

/** How many lines a marker says are missing, or 0 when the line is not one. */
function elidedBy(line: string): number {
  const m = /# \.\.\. (\d+) more (?:text )?line\(s\) not shown/.exec(line);
  return m ? Number(m[1]) : 0;
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
  // What an earlier pass already dropped, so trimming a trimmed tree reports
  // the whole loss rather than only this pass's share of it.
  let alreadyElided = 0;
  // The indent of the run being collapsed, captured when the run starts. Read
  // off the last KEPT line it used to be, which is the marker itself once a run
  // ends the tree, so a tail run marked its loss at the page root.
  let runIndent = 0;
  const flush = () => {
    if (collapsed === 0) return;
    kept.push(collapseLine(runIndent, collapsed));
    collapsed = 0;
  };
  for (const line of raw) {
    const isText = /^\s*- text:/.test(line);
    if (isText) {
      run += 1;
      if (run === 1) runIndent = indentOf(line);
      if (run > MAX_TEXT_RUN) {
        collapsed += 1;
        continue;
      }
    } else {
      flush();
      run = 0;
      alreadyElided += elidedBy(line);
    }
    kept.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line);
  }
  flush();

  if (kept.length <= maxLines) {
    return { yaml: kept.join("\n"), lines: kept.length, truncated: alreadyElided > 0 };
  }
  const head = kept.slice(0, maxLines - 1);
  // Everything this pass drops, plus everything an earlier pass dropped that
  // sat inside the part now cut away. A marker is not a line of the page, so
  // it contributes what it says was missing and never itself.
  const tail = kept.slice(head.length);
  const droppedNow = tail.filter((l) => elidedBy(l) === 0).length;
  const carried = tail.reduce((n, l) => n + elidedBy(l), 0);
  head.push(truncationLine(droppedNow + carried));
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
