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
 *
 * Prose grows in the block belonging to the call that wrote it, not in the last
 * block on the page. A check judges two view groups at once and both reach the
 * same panel at the same time, so their lines arrive interleaved; appending to
 * whatever came last would shred two verdicts into one another, and stacking a
 * new node per fragment would make a hundred paragraphs of one reply. Two
 * blocks that each grow in place is what the reader wants and what the data
 * actually is.
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
 * The paragraph each call in flight is still writing into.
 *
 * Keyed by call rather than by judge, because two calls to one judge run at the
 * same time. Entries are dropped when the call closes and are re-checked for
 * being on the page at all, since the cap below removes nodes from the top.
 */
const prose = new Map<string, HTMLElement>();

/** Throw away what is shown: a new run, or a page that has lost its place. */
export function clearTranscript(): void {
  el("streamLog").textContent = "";
  prose.clear();
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
  if (line.kind === "close") {
    prose.delete(line.call);
    return;
  }
  if (line.kind === "text") {
    const growing = prose.get(line.call);
    // `isConnected` because the cap removes nodes from the top of the log, and a
    // long call's paragraph can be evicted while the call is still writing.
    if (growing?.isConnected) {
      growing.textContent += line.text;
      return;
    }
  }
  // A tool call is a landmark, so it ends the paragraph it interrupts.
  if (line.kind === "tool") prose.delete(line.call);
  const node = document.createElement("div");
  node.className = `sl ${line.kind}`;
  if (line.kind === "open") {
    node.innerHTML = `<b>${esc(line.panel)}</b> ${esc(line.text)}`;
  } else {
    node.textContent = line.text;
    if (line.kind === "text") prose.set(line.call, node);
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
