/**
 * The rail down the right of the page: what the judge is saying, as it says it.
 *
 * Judging is the part of a run that takes the time, and until now it was the
 * part with nothing to look at. A view group is five model calls of about a
 * minute each and the page had one line to show for all of them, which reads
 * like a run that has died rather than one that is working.
 *
 * Appended to rather than repainted, which is the one thing that makes this
 * different from every other region on the page. `paint` exists because most
 * updates change one number and rewriting innerHTML would throw away a reader's
 * scroll position; here the update IS new content at the bottom, arriving
 * several times a second, and rebuilding the whole transcript for each one
 * would throw that scroll position away several times a second.
 */
import { el, esc } from "./dom.js";
import type { NarrationFrame, NarrationLine } from "../narration.js";

/**
 * How many lines the rail keeps.
 *
 * A long run says far more than anyone scrolls back through, and an unbounded
 * list of nodes is a page that gets slower the longer you leave it open.
 */
const MAX_NODES = 600;

/** Whether the reader is at the bottom, which is what decides if it follows. */
function pinned(log: HTMLElement): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

/**
 * A judge writes its verdict as one long delta stream, so consecutive prose
 * from the same judge is grown in place rather than stacked into a hundred
 * paragraphs. A tool call or a change of judge ends the run of it.
 */
let openProse: HTMLElement | null = null;
let openPanel = "";

/** Throw away what is shown: a new run, or a page that has lost its place. */
export function clearTranscript(): void {
  el("streamLog").textContent = "";
  openProse = null;
  openPanel = "";
  paintHead(null);
}

/** Append what the server just sent, following the bottom if the reader is there. */
export function addNarration(frame: NarrationFrame): void {
  if (frame.reset) clearTranscript();
  if (frame.lines.length === 0) return;
  const log = el("streamLog");
  const follow = pinned(log);
  for (const line of frame.lines) append(log, line);
  while (log.childElementCount > MAX_NODES) log.firstElementChild?.remove();
  paintHead(frame.lines[frame.lines.length - 1]!);
  if (follow) log.scrollTop = log.scrollHeight;
}

function append(log: HTMLElement, line: NarrationLine): void {
  if (line.kind === "text" && openProse && line.panel === openPanel) {
    openProse.textContent += line.text;
    return;
  }
  openProse = null;
  if (line.kind === "close") return;
  const node = document.createElement("div");
  node.className = `sl ${line.kind}`;
  if (line.kind === "open") {
    node.innerHTML = `<b>${esc(line.panel)}</b> ${esc(line.text)}`;
  } else if (line.kind === "tool") {
    node.textContent = line.text;
  } else {
    node.textContent = line.text;
    openProse = node;
    openPanel = line.panel;
  }
  log.append(node);
}

/** Who is speaking, above the transcript, so the rail says something at a glance. */
function paintHead(line: NarrationLine | null): void {
  const head = el("streamWho");
  const next = line ? line.panel : "";
  if (head.textContent !== next) head.textContent = next;
  el("stream").classList.toggle("talking", line !== null);
}
