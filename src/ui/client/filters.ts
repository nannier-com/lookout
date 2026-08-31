/**
 * The headline numbers, and what clicking one does.
 *
 * They are the page's navigation: there is no route to an issue, so narrowing
 * the board to "blocked" or "critical" is how a reader moves around it. The
 * counts and the filter live together because the tile is both.
 */
import { el, esc } from "./dom.js";
import { page, refresh, type Filter } from "./state.js";
import type { BoardEntry } from "../../report/board.js";

const STATES: Record<string, string[]> = {
  open: ["open", "still-open", "regressed", "verifying"],
  blocked: ["blocked"],
  done: ["done"],
  archived: ["archived"],
};
// Work that is finished with is kept and reachable, but it is not what the page
// opens on: unfiltered, this is a view of what still needs doing.
const SETTLED = ["done", "archived"];

export function matchesIssue(b: BoardEntry): boolean {
  if (!page.filter) return !SETTLED.includes(b.status);
  if (page.filter.kind === "state") return (STATES[page.filter.value] ?? []).includes(b.status);
  return b.severity === page.filter.value && !SETTLED.includes(b.status);
}


export function setFilter(kind: Filter["kind"], value: string, label: string): void {
  const same = page.filter && page.filter.kind === kind && page.filter.value === value;
  page.filter = same ? null : { kind, value, label };
  void refresh();
  if (!page.filter) return;
  const target = el("issues");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
}

export function statBody(v: number | string, l: string, c: string | undefined, zero: boolean): string {
  return '<b' + (c && !zero ? ' style="color:' + c + '"' : '') + '>' + esc(v) + '</b>'
    + '<span>' + esc(l) + '</span>';
}
export function stat(l: string, v: number | string, c?: string): string {
  const zero = v === 0 || v === "0";
  return '<div class="stat' + (zero ? ' z' : '') + '">' + statBody(v, l, c, zero) + '</div>';
}
export function statFilter(
  kind: Filter["kind"],
  value: string,
  l: string,
  v: number,
  c?: string,
): string {
  const zero = v === 0;
  const on = page.filter && page.filter.kind === kind && page.filter.value === value;
  return '<button type="button" class="stat' + (zero ? ' z' : '') + '"'
    + ' data-kind="' + esc(kind) + '" data-value="' + esc(value) + '"'
    + ' data-label="' + esc(l) + '"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
    + (zero ? ' disabled' : '')
    + ' title="' + (zero ? 'nothing to show'
        : value === "blocked"
          ? 'lookout ran out of attempts on these; they still need fixing'
          : 'show only ' + esc(l)) + '">'
    + statBody(v, l, c, zero) + '</button>';
}
