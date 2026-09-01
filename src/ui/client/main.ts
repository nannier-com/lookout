/**
 * The socket, the clicks, and the order things start in.
 *
 * Everything this file drives lives in a module beside it. What is left here is
 * the wiring: one socket the server pushes down, one delegated click listener
 * for a page whose regions are rebuilt under the reader whenever a run says
 * something, and the boot sequence, which is ordered rather than parallel for a
 * reason stated where it happens.
 *
 * The page used to poll every 1.5 seconds. It fetches twice now: once at boot,
 * because the board should be on screen before the socket has finished opening,
 * and again after any action the reader took, because an action should repaint
 * from its own answer rather than wait for the server to notice the disk moved.
 * Everything else arrives unasked.
 */
import { el, hit, repaint, ticks } from "./dom.js";
import { setFilter } from "./filters.js";
import { toggleSettings, loadConfigState, saveConfigState } from "./settings.js";
import { paintJudge, say, setView, toggleJudge } from "./shell.js";
import { render, runState } from "./status.js";
import { connected, listen } from "./stream.js";
import { addNarration } from "./transcript.js";
import { archive, chooseTool, launch, loadTools } from "./tools.js";
import { onRefresh, page, type Filter } from "./state.js";
import { closeShot, openShot, shotBackdrop, shotOpen } from "./shot-view.js";
import type { ProjectView } from "../project.js";
import type { NarrationFrame } from "../narration.js";
import type { StatusPayload } from "../payload.js";

/**
 * Ask for the board rather than wait to be told.
 *
 * Two callers: the boot, and every action that changes something and wants the
 * page to say so immediately.
 */
async function tick(): Promise<void> {
  try {
    render((await (await fetch("/api/status")).json()) as StatusPayload);
  } catch {
    // One missed request is not news. The page keeps what it last drew.
  }
}

/**
 * Ask for the judge's transcript rather than wait to be told.
 *
 * Only the fallback calls this. While the socket is open the transcript is
 * appended to as the judge speaks, which no poll could keep up with; without
 * one, a page still has to show a run working, and a whole replacement every
 * five seconds is the honest version of that.
 */
async function tickNarration(): Promise<void> {
  try {
    addNarration((await (await fetch("/api/narration")).json()) as NarrationFrame);
  } catch {
    // One missed request is not news. The page keeps what it last drew.
  }
}

/**
 * Start a check of the project lookout is pointed at, or stop the one running.
 *
 * Here rather than beside the button, because it is the one action that spans
 * two panels: the case play cannot handle is the one where there is nothing to
 * run, which is the cog's business.
 */
async function findAndFix(): Promise<void> {
  const btn = el("findfix") as HTMLButtonElement;
  // A run in flight makes this the stop button. Checked before the configured
  // question, because a run can outlive the settings that started it.
  if (page.project.checkRunning) {
    await stopRun(btn);
    return;
  }
  // Configuring is the cog's job. Play only ever runs, and says so plainly when
  // there is nothing to run.
  if (!page.project.configured) {
    say("no project configured yet: open settings and choose one");
    if (el("settings").hidden) toggleSettings();
    return;
  }
  btn.disabled = true;
  try {
    const r = (await (await fetch("/api/check", { method: "POST" })).json()) as {
      started: boolean;
      reason?: string;
    };
    // A refusal names the target that is down and how to start it, so it stays
    // up until something replaces it.
    say(r.started ? null : r.reason || "could not start");
    await tick();
  } finally {
    btn.disabled = false;
  }
}

/**
 * Stop the run, and the judge underneath it.
 *
 * The page says what it asked for rather than what happened, because what
 * happens takes a moment: the server signals the run's whole process group and
 * the browser it is driving closes on its way out. The button stays a stopping
 * one until the server says the run is gone, which is a fact from the server
 * rather than an assumption made here.
 */
async function stopRun(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const r = (await (await fetch("/api/stop", { method: "POST" })).json()) as {
      stopped: boolean;
      reason?: string;
    };
    say(r.stopped ? null : r.reason || "nothing to stop");
    await tick();
  } finally {
    // Whether it stays disabled is the payload's call, not this handler's: a
    // run that is still closing keeps the button down, and one already gone
    // hands it back as play.
    btn.disabled = page.project.checkStopping;
  }
}

// Delegated, because the filter row is rebuilt whenever its numbers move.
document.addEventListener("click", (e) => {
  // The clear control is styled as a tile, so it must be taken out first: it
  // carries no kind or value, and falling into the branch below would set a
  // filter matching nothing at all.
  if (page.filter && hit(e, "#clearTile")) {
    setFilter(page.filter.kind, page.filter.value, page.filter.label);
    return;
  }
  // Two close controls, one handler: the bar's button and the one in the
  // corner of the picture itself.
  if (hit(e, "#svClose,#svX")) { closeShot(); return; }
  // Clicking the scrim beside the picture closes it too, because that is the
  // gesture people reach for before they look for a button.
  if (shotOpen() && shotBackdrop(e)) { closeShot(); return; }
  // A plain click on a shot tile opens the inspector; modified clicks keep
  // the anchor's own behavior, so cmd-click still opens the raw PNG.
  const shotTile = hit(e, "a.tile");
  if (shotTile?.dataset.shot && e instanceof MouseEvent
      && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
    e.preventDefault();
    openShot(shotTile);
    return;
  }
  const area = hit(e, "[data-view]");
  if (area?.dataset.view) { setView(area.dataset.view); return; }
  const swap = hit(e, "[data-tool]");
  if (swap?.dataset.tool) {
    chooseTool(swap.dataset.tool);
    // The launch buttons name the tool, so they have to be redrawn with it.
    repaint("board");
    void tick();
    return;
  }
  if (hit(e, "#findfix")) { void findAndFix(); return; }
  // Consent is stored on the server against the project it was given for, not
  // in this browser: it authorizes a run that clicks the application's own
  // controls, and the run is the server's to start.
  if (hit(e, "#navToggle")) {
    void saveConfigState({ navigation: !page.config.navigation });
    return;
  }
  if (hit(e, "#cog")) { toggleSettings(); return; }
  if (hit(e, "#streamFold")) { toggleJudge(); return; }
  if (hit(e, "#pickProject")) {
    void (async () => {
      const picked = (await (await fetch("/api/pick", { method: "POST" })).json()) as
        ProjectView & { cancelled?: boolean };
      if (picked.cancelled) return;
      if (picked.error) { say(picked.error); return; }
      if (!picked.configured) { say("no lookout.config.ts in " + picked.projectDir); return; }
      await saveConfigState({ projectDir: picked.projectDir });
    })();
    return;
  }
  if (hit(e, "#saveUrl")) {
    void saveConfigState({ baseUrl: (el("setUrl") as HTMLInputElement).value });
    return;
  }
  const go = hit(e, "[data-launch]");
  if (go?.dataset.launch) { void launch(go.dataset.launch, go as HTMLButtonElement); return; }
  const file = hit(e, "[data-archive]");
  if (file?.dataset.archive) {
    void archive(file.dataset.archive, file as HTMLButtonElement, !file.dataset.restore);
    return;
  }
  const tile = hit(e, "button.stat") as HTMLButtonElement | null;
  if (tile && !tile.disabled && tile.dataset.kind && tile.dataset.value) {
    setFilter(tile.dataset.kind as Filter["kind"], tile.dataset.value, tile.dataset.label ?? "");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // The inspector claims Escape first: closing an overlay somebody is looking
  // at must never silently clear their filter underneath it.
  if (shotOpen()) { closeShot(); return; }
  if (page.filter) setFilter(page.filter.kind, page.filter.value, page.filter.label);
});
// The fold is drawn before anything is fetched: whether the judge's column is
// open was decided on a previous visit, and the page should come back the shape
// it was left in rather than widen a moment later.
paintJudge();

// Tools first: the launch buttons are labelled with the chosen one, and a board
// painted before the list arrives says "open in your editor".
// Settings first: the saved project decides whether Play is even live, so
// resolving it before the first poll avoids a green button flashing grey.
// The fetch is what redraws the page on demand, so it registers itself as the
// refresher every other module asks for. Without this a filter click would
// change the state and nothing would repaint.
onRefresh(tick);

void loadConfigState()
  .then(loadTools)
  .then(tick)
  .then(() => listen({ status: render, narration: addNarration }));
// Enter in the URL box saves, which is what anyone typing a URL expects.
document.addEventListener("keydown", (e) => {
  const target = e.target;
  if (e.key === "Enter" && target instanceof HTMLInputElement && target.id === "setUrl") {
    e.preventDefault();
    void saveConfigState({ baseUrl: target.value });
  }
});
// The only fallback left. While the socket is open this does nothing at all;
// while it is not, the page is still a page and should still be right.
setInterval(() => {
  if (connected()) return;
  void tick();
  void tickNarration();
}, 5000);
// Both of these are clocks rather than requests. `ticks` re-renders every
// duration on the page from the current time, and `runState` re-reads how long
// the run has been silent: a run killed outright says nothing more, so the only
// way the page can notice is by looking at the clock itself.
setInterval(() => {
  ticks();
  runState();
}, 1000);
