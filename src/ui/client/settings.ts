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
  // Both boxes are left alone while somebody is typing in them: the panel
  // repaints whenever the run log moves, and a repaint that overwrote a
  // half-typed path would be indistinguishable from the page fighting back.
  const dir = el("setProject") as HTMLInputElement;
  if (document.activeElement !== dir) dir.value = page.config.projectDir || "";
  dir.title = page.config.projectDir || "";
  const input = el("setUrl") as HTMLInputElement;
  if (document.activeElement !== input) input.value = page.config.baseUrl || "";
  const box = el("setTargets");
  if (page.config.error) {
    box.innerHTML = '<div class="tgt down">' + esc(page.config.error) + "</div>";
  } else if (!page.config.configured) {
    box.innerHTML = '<div class="tgt">No lookout.config.ts here. Choose a folder above, or type its path.</div>';
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
  // The device fold, when the project has one: each booted simulator or
  // emulator, or the gap that would stop a run, in the same rows the targets
  // use, because to the person opening this panel they are the same question.
  if (page.config.configured && !page.config.error) {
    box.innerHTML += page.config.devices.map((d) =>
      '<div class="tgt"><span class="' + (d.up ? "up" : "down") + '">' + esc(d.line) + "</span></div>").join("");
  }
  paintNav();
  paintPlay();
}

/**
 * The calls-to-action consent, under the cog.
 *
 * On, the next run clicks this project's own buttons and links and photographs
 * what they open, so the judge sees the menus, drawers and dialogs no shot of a
 * route at rest can reach. It belongs in this panel rather than in a config
 * file because it is a decision about one repository that somebody has to make
 * knowingly: everything planned gets actuated, destructive controls included,
 * and ordering the clicks by risk is not the same as declining to make them.
 * So the row says which of the two runs play will spend, in words, rather than
 * leaving it to the state of an icon.
 *
 * Off is the state a project starts in, and the yes is stored against the
 * directory it was given for, so a `.lookout/` copied into another checkout
 * does not carry permission to click that one's buttons.
 */
export function paintNav(): void {
  const btn = el("navToggle") as HTMLButtonElement;
  const on = page.config.navigation;
  const ready = !!page.project.configured;
  btn.disabled = !ready;
  btn.classList.toggle("on", on);
  btn.textContent = on ? "Turn off" : "Turn on";
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "Calls to action will be clicked" : "Click the calls to action");
  btn.title = ready ? "" : "This directory has no lookout.config.ts";
  const state = el("setNavState");
  state.textContent = !ready ? "no config here" : on ? "On for this project" : "Off";
  state.classList.toggle("on", ready && on);
  el("setNavHint").textContent = on
    ? "The next run clicks this project's buttons and links and photographs what they open, "
      + "destructive controls included. Remembered for this project only."
    : "Runs photograph each route at rest. Turn this on to have a run click this project's "
      + "buttons and links, destructive controls included, and judge what they open.";
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

/**
 * Take the panel's own answer and repaint from it.
 *
 * Every settings write answers with the whole view, so the page never has to
 * guess what a save did: the same handling serves a saved base URL, a typed
 * project and a folder chosen from the native picker. A cancelled picker
 * answers with nothing to apply, which is not an error and not a repaint.
 */
async function applySettingsResponse(res: Response): Promise<void> {
  const data = (await res.json()) as SettingsView & { error?: string; cancelled?: boolean };
  if (data.cancelled) return;
  if (data.error) { say(data.error); return; }
  page.config = data;
  page.project.configured = !!page.config.configured;
  say(null);
  repaint("board");
  paintSettings();
  await refresh();
}

export async function saveConfigState(body: Record<string, string | boolean>): Promise<void> {
  await applySettingsResponse(
    await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Ask the server to open a native folder chooser, and take what comes back. */
export async function pickProject(): Promise<void> {
  await applySettingsResponse(await fetch("/api/pick", { method: "POST" }));
}

/** Point lookout at a path somebody typed rather than chose. */
export async function saveProject(dir: string): Promise<void> {
  if (!dir.trim()) return;
  await applySettingsResponse(
    await fetch("/api/project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dir.trim() }),
    }),
  );
}

export function toggleSettings(): void {
  const panel = el("settings");
  const open = panel.hidden;
  panel.hidden = !open;
  el("cog").setAttribute("aria-expanded", String(open));
  if (open) loadConfigState();
}
