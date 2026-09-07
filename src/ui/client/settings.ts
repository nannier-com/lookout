/**
 * Where lookout is pointed, and whether those targets answer right now.
 *
 * Configuring is its own act, not something a run does on the way past. The
 * probe is what makes the panel worth opening: a wrong port shows up before a
 * run is spent on it rather than after.
 */
import { el, esc, paint, repaint } from "./dom.js";
import { paintPlay, say } from "./shell.js";
import { page, refresh } from "./state.js";
import type { SettingsView } from "../project.js";

type Judge = SettingsView["judges"][number];

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
  paintJudges();
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

export async function saveConfigState(
  body: Record<string, string | boolean | Record<string, string>>,
): Promise<void> {
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

/**
 * Open the panel or shut it, and say which the cog will do next.
 *
 * The cog is the only control that opens this, so while the panel is open it is
 * also the only obvious way back out, and a button labelled "Settings" beside
 * an open settings panel does not read as that way. It says what pressing it
 * does instead, which costs two attributes and is the difference between a
 * panel with a way out and one somebody has to guess at. Escape is the other
 * way out, and it is the one people try first.
 */
function setSettingsOpen(open: boolean): void {
  el("settings").hidden = !open;
  const cog = el("cog");
  cog.setAttribute("aria-expanded", String(open));
  cog.setAttribute("aria-label", open ? "Close settings" : "Settings");
  cog.setAttribute("title", open ? "Close settings (Esc)" : "Settings");
  if (open) void loadConfigState();
}

export function toggleSettings(): void {
  setSettingsOpen(el("settings").hidden);
}

/** Shut it, for the Escape that dismisses whatever is open. */
export function closeSettings(): void {
  setSettingsOpen(false);
}

/** Whether it is open, so Escape can tell there is something to dismiss. */
export function settingsOpen(): boolean {
  return !el("settings").hidden;
}

/**
 * Which model each judge rules with, chosen from what that CLI actually offers.
 *
 * A menu rather than a text box, and the names in it are not lookout's. They
 * are read off the install on this machine (`probeCli`), so a newer CLI offers
 * newer names and an older one offers older names without lookout claiming to
 * know either. That is what makes a menu safe here: the old objection to one
 * was that a baked-in list would be wrong within a release while still looking
 * authoritative, and a list nobody baked cannot go stale.
 *
 * Two things the menu still has to allow, or it would take away what the text
 * box could do:
 *
 *   a pinned name    a full model name, for judging that has to stay
 *                    reproducible across a CLI upgrade. Kept reachable through
 *                    Custom, and preselected there when what is stored is not
 *                    a name the probe returned.
 *   no menu at all   an install the probe could not question still gets the
 *                    text box, because refusing to accept a typed name would
 *                    be a worse answer than the one being replaced.
 *
 * The version under the menu is the same probe's other half. It says WHICH
 * install these names came from, which is the difference between a menu that
 * looks authoritative and one that shows its source.
 */
export function paintJudges(): void {
  const judges = page.config.judges ?? [];
  // What is typed or picked is deliberately absent from the signature. This
  // repaints whenever the run log moves, and one that redrew a row mid-choice
  // would discard a half-typed name and read as the page fighting back.
  const sig = judges
    .map((j) => [j.key, j.model ?? "", j.installed, j.version ?? "", j.models.join(",")].join(":"))
    .join("|");
  paint("setJudges", sig, judges.map(judgeRow).join(""));
}

/** One judge: the menu, the name it may still have to be told, and the hint. */
function judgeRow(j: Judge): string {
  const custom = !!j.model && !j.models.includes(j.model);
  return '<div class="srow"><span>' + esc(j.label) + " model</span>"
    + (j.models.length ? menu(j, custom) : "")
    + '<input type="text" data-model="' + esc(j.key) + '" spellcheck="false" autocomplete="off"'
    + ' value="' + esc(j.model ?? "") + '"'
    + ' placeholder="' + esc(j.defaultModel) + ' (lookout\'s default)"'
    + (j.models.length && !custom ? " hidden" : "")
    + ' aria-label="Model ' + esc(j.label) + ' judges with">'
    + '<button type="button" class="mini" data-save-model="' + esc(j.key) + '">Save</button></div>'
    + version(j)
    + '<p class="shint">What rules on this project, and what the ledger files each verdict under. '
    + (j.installed ? "" : esc(j.label) + " is not on PATH here, so nothing will run until it is. ")
    + "Empty means " + esc(j.defaultModel) + ", which is what every run uses when nobody has chosen.</p>";
}

/**
 * The names this CLI offers, plus the two choices that are not names.
 *
 * The empty option is lookout's default, spelled with the default the SERVER
 * reported so the page never states one of its own; CUSTOM reveals the box for
 * a name the probe did not return.
 */
function menu(j: Judge, custom: boolean): string {
  const chosen = custom ? CUSTOM : (j.model ?? "");
  const opt = (value: string, label: string): string =>
    '<option value="' + esc(value) + '"' + (value === chosen ? " selected" : "") + ">" + esc(label) + "</option>";
  return '<select data-model-menu="' + esc(j.key) + '"'
    + ' aria-label="Model ' + esc(j.label) + ' judges with">'
    + opt("", j.defaultModel + " (lookout's default)")
    + j.models.map((m) => opt(m, m)).join("")
    + opt(CUSTOM, "Custom...")
    + "</select>";
}

/**
 * Which install the names above came from.
 *
 * Under the menu rather than beside the label, because it is a property of the
 * list and not of the choice: it answers "where did these names come from", and
 * it is the thing to look at when the name somebody expected is not offered.
 */
function version(j: Judge): string {
  if (!j.version) return "";
  return '<p class="sver">' + esc(j.label) + " " + esc(j.version) + "</p>";
}

/**
 * The menu entry that means "not one of these", and reveals the text box.
 *
 * Leading `~` so it can never collide with something the probe returned:
 * `validModel` requires a name to start with a letter or a digit, so a model
 * spelled this way could not be stored even if a CLI offered one.
 */
export const CUSTOM = "~custom";

/**
 * What the Save button beside a judge should store.
 *
 * The menu is the answer unless it points at Custom, in which case the box is.
 * One function because the click handler must not have to know which of the two
 * controls is showing: that is this row's business, not the page's.
 */
export function chosenModel(key: string): string | null {
  const sel = document.querySelector('[data-model-menu="' + CSS.escape(key) + '"]') as HTMLSelectElement | null;
  const box = document.querySelector('[data-model="' + CSS.escape(key) + '"]') as HTMLInputElement | null;
  if (sel && sel.value !== CUSTOM) return sel.value;
  return box ? box.value : null;
}

/**
 * Show the box when Custom is picked, and hide it again when it is not.
 *
 * Immediate rather than on save: a menu that offered Custom and then showed
 * nothing to type into would be a dead end.
 */
export function revealCustom(sel: HTMLSelectElement): void {
  const key = sel.dataset.modelMenu;
  if (!key) return;
  const box = document.querySelector('[data-model="' + CSS.escape(key) + '"]') as HTMLInputElement | null;
  if (!box) return;
  box.hidden = sel.value !== CUSTOM;
  if (!box.hidden) box.focus();
}
