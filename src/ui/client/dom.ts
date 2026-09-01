/**
 * The four things every part of this page does.
 *
 * Escape text, find an element, repaint a region only when it actually changed,
 * and spell a path safely into a URL. They are here rather than in whichever
 * module happened to need them first, because every other client module needs
 * all four and none of them owns any.
 *
 * `paint` is the one with a reason to exist. The page polls every 1.5 seconds
 * and most polls change nothing; rewriting innerHTML anyway would throw away
 * scroll positions, hover states and text selections several times a minute.
 * So a region carries a signature of what it last drew, and redraws only when
 * that moves.
 */

/** What each region last painted, by element id. */
const last: Record<string, string> = {};

export function paint(id: string, sig: string, html: string): boolean {
  if (last[id] === sig) return false;
  last[id] = sig;
  el(id).innerHTML = html;
  return true;
}

/** Forget a region's signature, so the next paint redraws it. */
export function repaint(id: string): void {
  delete last[id];
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/**
 * Everything the page interpolates goes through here.
 *
 * The page is built by string concatenation, so this is the whole of its
 * defence: a judge's note, a route, a file path and a commit subject are all
 * text somebody else wrote, and any of them can carry a bracket.
 */
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);

/**
 * An element the page declares in its own markup.
 *
 * Throws rather than returning null: every id passed here is written in the
 * shell a few lines away, so a miss is a typo in this codebase, not a state
 * the page can be in, and a named error beats a null dereference three frames
 * later.
 */
export function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error("the page has no element #" + id);
  return node;
}

/**
 * The element matching a selector, or a detached one nobody sees.
 *
 * A card can be repainted away between a click and the answer to the request
 * that click started. Writing the outcome into a detached node is the honest
 * result of that race, and it beats a null check at every call site that would
 * have nothing useful to do in the null case anyway.
 */
export function slot(selector: string): HTMLElement {
  return document.querySelector<HTMLElement>(selector) ?? document.createElement("span");
}

/**
 * The element a click landed on, or the nearest one matching.
 *
 * Every listener on this page is delegated, because the regions they cover are
 * rebuilt under them several times a minute. An event target is not necessarily
 * an element (it can be the document, or a node with no ancestors left), so
 * this is the one place that check is made.
 */
export function hit(e: Event, selector: string): HTMLElement | null {
  const target = e.target;
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

/** Encode a path for a URL without turning its separators into %2F. */
export const enc = (p: string): string => String(p).split("/").map(encodeURIComponent).join("/");

/** A duration a person reads at a glance, not a precise one. */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + String(s % 60).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h" + String(m % 60).padStart(2, "0") + "m";
  return Math.floor(h / 24) + "d";
}

/**
 * How long ago something happened, said the way a person says it.
 *
 * Separate from `dur`, because the two answer different questions. A run's
 * clock is a live measurement and its seconds are the whole point: watching
 * `3m20s` become `3m21s` is how a reader can tell the run has not hung. An age
 * is a statement about the past, and rendering one to the second turns "this
 * screenshot is about an hour old" into a stopwatch that appears to be timing
 * the reader. Every card on the board carries one, so sixty of them counted up
 * in unison while nothing at all was happening, which is what they were read
 * as: a clock running against the person who had not fixed the issue yet.
 *
 * It also carries the word the number was missing. `seen 41m17s` can be read as
 * "seen for 41 minutes"; `seen 41m ago` cannot.
 */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

/**
 * Advance every clock on the page.
 *
 * The server sends timestamps, not durations, because a duration is stale the
 * moment it is serialised. Anything carrying `data-since` renders itself from
 * the current time here, once a second, without another request. `data-age`
 * says the timestamp is a moment in the past rather than the start of
 * something still going, which is the difference between the two formatters
 * above.
 */
export function ticks(): void {
  for (const n of document.querySelectorAll<HTMLElement>("[data-since]")) {
    const to = n.dataset.until ? Date.parse(n.dataset.until) : Date.now();
    const elapsed = to - Date.parse(n.dataset.since ?? "");
    const text = (n.dataset.prefix || "") + (n.dataset.age === undefined ? dur(elapsed) : age(elapsed));
    // Written only when it says something different. An age reads the same for
    // a whole minute, and replacing sixty text nodes a second to paint the
    // characters that were already there is work nobody asked for.
    if (n.textContent !== text) n.textContent = text;
  }
}
