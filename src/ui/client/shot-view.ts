/**
 * The shot inspector: click a tile, see the screenshot full size. When the
 * shot advertises a provenance sidecar the overlay draws element boxes over
 * it (rendered by shot-project.ts once that half lands); without one it is
 * still a useful lightbox, and says so instead of pretending.
 *
 * A dialog, not a route: the page is one shell with no router, and the
 * overlay lives outside every painted region so the poll never rewrites it.
 */
import { el, enc, esc, hit } from "./dom.js";
import { hintOf, project, type SvBox, type SvSidecar } from "./shot-project.js";

let opener: HTMLElement | null = null;
let boxes: SvBox[] = [];

function paintHint(i: number): void {
  const b = boxes[i];
  if (b) el("svHint").textContent = hintOf(b.el);
}

async function loadBoxes(prov: string): Promise<void> {
  let sc: SvSidecar | null = null;
  try {
    const res = await fetch("/evidence/" + enc(prov));
    if (res.ok) sc = (await res.json()) as SvSidecar;
  } catch {
    sc = null;
  }
  if (!sc || sc.version !== 1) {
    el("svHint").textContent = "no provenance recorded for this shot";
    return;
  }
  boxes = project(sc);
  el("svBoxes").innerHTML = boxes
    .map(
      (b, i) =>
        '<button type="button" class="svbox" data-i="' + i + '"'
        + ' style="left:' + b.left.toFixed(3) + "%;top:" + b.top.toFixed(3)
        + "%;width:" + b.width.toFixed(3) + "%;height:" + b.height.toFixed(3) + '%"'
        + ' aria-label="' + esc(hintOf(b.el)) + '"></button>',
    )
    .join("");
  el("svHint").textContent = boxes.length
    ? boxes.length + " element(s): hover or tab to read, click to pin"
    : "no elements recorded for this shot";
}

// Hover, keyboard focus, and click all paint the same hint; click pins it so
// the touch story and screenshots have a deterministic state.
for (const kind of ["mouseover", "focusin"] as const) {
  document.addEventListener(kind, (e) => {
    const b = hit(e, "button.svbox");
    if (b?.dataset.i) paintHint(Number(b.dataset.i));
  });
}
document.addEventListener("click", (e) => {
  const b = hit(e, "button.svbox");
  if (!b?.dataset.i) return;
  for (const s of document.querySelectorAll(".svbox.sel")) s.classList.remove("sel");
  b.classList.add("sel");
  paintHint(Number(b.dataset.i));
});

/** Whether the inspector is up, for whoever handles Escape first. */
export function shotOpen(): boolean {
  return !el("shotview").hidden;
}

export function openShot(tile: HTMLElement): void {
  const path = tile.dataset.shot;
  if (!path) return;
  el("svTitle").textContent = tile.dataset.label ?? path;
  (el("svRaw") as HTMLAnchorElement).href = "/evidence/" + enc(path);
  const img = el("svImg") as HTMLImageElement;
  img.src = "/evidence/" + enc(path);
  el("svBoxes").innerHTML = "";
  boxes = [];
  el("svHint").textContent = tile.dataset.prov
    ? "loading element provenance…"
    : "no provenance recorded for this shot";
  opener = tile;
  el("shotview").hidden = false;
  document.body.classList.add("shotopen");
  (el("svClose") as HTMLButtonElement).focus();
  if (tile.dataset.prov) void loadBoxes(tile.dataset.prov);
}

export function closeShot(): void {
  el("shotview").hidden = true;
  document.body.classList.remove("shotopen");
  // Focus goes home so keyboard readers do not fall off the page. The tile
  // may have been repainted away by the poll; its selector still matches the
  // board's current DOM when the issue survived.
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
}
