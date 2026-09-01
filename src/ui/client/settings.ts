/**
 * Where lookout is pointed, and whether those targets answer right now.
 *
 * Configuring is its own act, not something a run does on the way past. The
 * probe is what makes the panel worth opening: a wrong port shows up before a
 * run is spent on it rather than after.
 */
import { el, esc, repaint } from "./dom.js";
import { paintPlay, say } from "./shell.js";
import { page, refresh } from "./state.js";
import type { SettingsView } from "../project.js";

// What the settings panel is showing, so Play can refuse before it spends
// anything and the cog can render without a round trip.
export function paintSettings(): void {
  el("setProject").textContent = page.config.projectDir || "not set";
  el("setProject").title = page.config.projectDir || "";
  const input = el("setUrl") as HTMLInputElement;
  if (document.activeElement !== input) input.value = page.config.baseUrl || "";
  const box = el("setTargets");
  if (page.config.error) {
    box.innerHTML = '<div class="tgt down">' + esc(page.config.error) + "</div>";
  } else if (!page.config.configured) {
    box.innerHTML = '<div class="tgt">Choose a folder holding lookout.config.ts.</div>';
  } else if (!page.config.targets.length) {
    box.innerHTML = '<div class="tgt">That config declares no targets.</div>';
  } else {
    // Reachability here is the point of opening the panel: a wrong port shows
    // up before a run is spent on it rather than after.
    box.innerHTML = page.config.targets.map((t) =>
      '<div class="tgt"><b>' + esc(t.name) + "</b> " + esc(t.url) +
      "  (" + t.routes + " route" + (t.routes === 1 ? "" : "s") + ")  " +
      '<span class="' + (t.up ? "up" : "down") + '">' +
      (t.up ? "reachable" : "not responding" + (t.status ? " (HTTP " + t.status + ")" : "")) +
      "</span></div>").join("");
  }
  paintPlay();
}

export async function loadConfigState(): Promise<void> {
  try {
    page.config = (await (await fetch("/api/settings")).json()) as SettingsView;
  } catch {
    // The server is not answering; keep showing what was last true.
    return;
  }
  page.project.configured = !!page.config.configured;
  paintSettings();
}

export async function saveConfigState(body: Record<string, string | boolean>): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as SettingsView & { error?: string };
  if (data.error) { say(data.error); return; }
  page.config = data;
  page.project.configured = !!page.config.configured;
  say(null);
  repaint("board");
  paintSettings();
  await refresh();
}

export function toggleSettings(): void {
  const panel = el("settings");
  const open = panel.hidden;
  panel.hidden = !open;
  el("cog").setAttribute("aria-expanded", String(open));
  if (open) loadConfigState();
}
