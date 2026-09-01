/**
 * The frame around both areas: what lookout is doing, where it is pointed, the
 * one button that starts a run, and the rail that switches areas.
 *
 * Play is three states on purpose. Grey until something is configured, because
 * a green "go" that can only produce an error is a lie told by a colour; green
 * when it would really run; a turning ring while it is running.
 */
import { el } from "./dom.js";
import { loadLearning } from "./learning.js";
import { page } from "./state.js";
import type { StatusPayload } from "../payload.js";

/**
 * Why the last thing you asked for did not happen.
 *
 * This exists because the reason used to be written straight into the "where"
 * element, which tick() then overwrote with the project path on its next poll.
 * Every explanation this page produced was erased within a second of appearing,
 * so picking an unusable folder looked identical to picking a fine one and
 * getting no results. Held as state instead, with the poll rendering the notice
 * when there is one and the path otherwise, so precedence is decided not raced.
 */
export function say(message: string | null): void {
  page.notice = message;
  paintWhere();
}

export function paintWhere(): void {
  const where = el("where");
  const text = page.notice ?? page.project.projectDir;
  if (where.textContent !== text) where.textContent = text;
  where.title = page.notice ? page.notice + "\n\n" + page.project.projectDir : page.project.projectDir;
  where.classList.toggle("notice", page.notice !== null);
}

/**
 * Play, in one of three states.
 *
 * Grey until something is configured, because a green "go" that can only
 * produce an error is a lie told by a colour. Green when it would really run.
 * A turning ring while it is running.
 */
export function paintPlay(): void {
  const btn = el("findfix");
  const ready = !!page.project.configured;
  btn.classList.toggle("busy", page.project.checkRunning);
  btn.classList.toggle("unset", !ready && !page.project.checkRunning);
  if (!btn.querySelector("svg")) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">'
      + '<path fill="currentColor" d="M8 5.2 19 12 8 18.8Z"/></svg>';
  }
  // The name lives in the accessible label and the tooltip: the control is a
  // shape, because the whole of it means "go".
  const name = page.project.checkRunning
    ? "looking for an issue"
    : ready ? "Find and fix" : "Nothing configured yet";
  btn.setAttribute("aria-label", name);
  btn.title = page.project.checkRunning
    ? "lookout is checking " + (page.config.projectDir || page.project.projectDir)
    : ready
      ? "Find and fix: one check of " + (page.config.projectDir || page.project.projectDir) +
        ", stopping at the first issue"
      : "Open settings (the cog) and choose a project first";
  // The toggle is drawn with play because it changes what pressing play does,
  // and every repaint path that reaches one should reach the other.
  paintNav();
}

/**
 * The calls-to-action toggle, beside play.
 *
 * On, the next run clicks this project's own buttons and links and photographs
 * what they open, so the judge sees the menus, drawers and dialogs no shot of a
 * route at rest can reach. That is worth a control on the page rather than a
 * line in a config file, because it is the only thing this button can start
 * that touches the application instead of reading it: everything planned gets
 * actuated, destructive controls included, and ordering the clicks by risk is
 * not the same as declining to make them. Anyone about to press play should be
 * able to see which of the two runs they are about to spend.
 *
 * Off is the state a project starts in, and pointing the page at a different
 * project puts it back there.
 */
export function paintNav(): void {
  const btn = el("navToggle") as HTMLButtonElement;
  const on = page.config.navigation;
  btn.disabled = !page.project.configured;
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "Calls to action will be clicked" : "Click the calls to action");
  btn.title = !page.project.configured
    ? "Choose a project first"
    : on
      ? "Calls to action: ON. The next run clicks this project's buttons and links and "
        + "photographs what they open, destructive controls included."
      : "Calls to action: off. Runs photograph each route at rest. Turn this on to click "
        + "this project's buttons and links, destructive controls included.";
}

/**
 * Whether the judge's column is folded away.
 *
 * Remembered per browser rather than per project, for the same reason the tool
 * choice is: whether you want a transcript beside the board is a preference
 * about the reader, not about the repository being looked at.
 */
let judgeShut = false;
try {
  judgeShut = localStorage.getItem("lookout.judge") === "shut";
} catch {
  // A private window refuses storage. The preference is then per visit.
}

/**
 * The fold, in whichever state it is in.
 *
 * Two classes, because they do two different things. The one on the body
 * narrows the token that both the column's width and the board's padding are
 * written in, so neither can move without the other. The one on the column is
 * what turns its header into the strip.
 */
export function paintJudge(): void {
  const btn = el("streamFold");
  el("stream").classList.toggle("shut", judgeShut);
  document.body.classList.toggle("judgeshut", judgeShut);
  btn.setAttribute("aria-expanded", String(!judgeShut));
  // Shut, the strip says nothing on its own, so the name lives in the label and
  // the tooltip, the way the rail's icons do at the other edge.
  const name = judgeShut ? "Show the judge's transcript" : "Collapse the judge's transcript";
  btn.setAttribute("aria-label", name);
  btn.title = name;
}

export function toggleJudge(): void {
  judgeShut = !judgeShut;
  try {
    localStorage.setItem("lookout.judge", judgeShut ? "shut" : "open");
  } catch {
    // Storage refused: the fold still works, it just does not outlive the tab.
  }
  paintJudge();
}

export function setView(next: string): void {
  if (page.view === next) return;
  page.view = next;
  el("viewIssues").hidden = page.view !== "issues";
  el("learning").hidden = page.view !== "learning";
  // The headline numbers are the board's filters. They go with it.
  el("stats").hidden = page.view !== "issues";
  for (const b of document.querySelectorAll<HTMLElement>("[data-view]")) {
    b.setAttribute("aria-current", b.dataset.view === page.view ? "page" : "false");
  }
  if (page.view === "learning") loadLearning();
}

// The rail's dot: violet and pulsing while lookout is changing itself, amber
// while something it wrote is waiting for somebody to read it, gone otherwise.
export function paintRail(b: StatusPayload["status"]["learning"] | undefined): void {
  const dot = el("railDot");
  const running = !!(b && b.running);
  const waiting = !!(b && b.proposed);
  dot.hidden = !running && !waiting;
  dot.className = running ? "rdot live" : "rdot";
  dot.title = running
    ? "lookout is working on itself right now"
    : waiting ? "an amendment lookout wrote is waiting to be read" : "";
}
