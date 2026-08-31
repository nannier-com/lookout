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
  where.classList.toggle("page.notice", page.notice !== null);
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
