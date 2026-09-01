/**
 * The shot inspector: click a tile, see the screenshot full size. When the
 * shot advertises a provenance sidecar the overlay draws element boxes over
 * it (rendered by shot-project.ts once that half lands); without one it is
 * still a useful lightbox, and says so instead of pretending.
 *
 * A dialog, not a route: the page is one shell with no router, and the
 * overlay lives outside every painted region so the poll never rewrites it.
 */
import { el, enc } from "./dom.js";

let opener: HTMLElement | null = null;

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
  el("svHint").textContent = tile.dataset.prov
    ? "loading element provenance…"
    : "no provenance recorded for this shot";
  opener = tile;
  el("shotview").hidden = false;
  document.body.classList.add("shotopen");
  (el("svClose") as HTMLButtonElement).focus();
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
