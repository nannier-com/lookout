/**
 * The poll, the clicks, and the order things start in.
 *
 * Everything this file drives lives in a module beside it. What is left here is
 * the wiring: one request every 1.5 seconds, one delegated click listener for a
 * page whose regions are rebuilt under the reader several times a minute, and
 * the boot sequence, which is ordered rather than parallel for a reason stated
 * where it happens.
 */
import { el, esc, paint, repaint, ticks } from "./dom.js";
import { card } from "./board.js";
import { matchesIssue, setFilter, stat, statFilter } from "./filters.js";
import { loadLearning } from "./learning.js";
import { paintRail, paintWhere, paintPlay, say, setView } from "./shell.js";
import { loadConfigState, saveConfigState, toggleSettings } from "./settings.js";
import { archive, chooseTool, launch, loadTools, paintToggle } from "./tools.js";
import { onRefresh, page, type Filter } from "./state.js";
import { closeShot, openShot, shotOpen } from "./shot-view.js";
import { hit } from "./dom.js";
import type { ProjectView } from "../project.js";
import type { StatusPayload } from "../payload.js";

const STALE_MS = 10 * 60 * 1000;

async function tick(): Promise<void> {
  let d: StatusPayload;
  try {
    d = (await (await fetch("/api/status")).json()) as StatusPayload;
  } catch {
    // One missed poll is not news. The page keeps what it last drew.
    return;
  }
  paintToggle();
  const s = d.status;

  // lookout cannot see a process die, so a killed run leaves the log claiming it
  // is still running, forever. Silence is the only evidence available: past
  // STALE_MS with nothing said, stop animating and say how long it has been
  // quiet rather than show a live clock for a run that ended hours ago.
  const silent = s.lastEventAt ? Date.now() - Date.parse(s.lastEventAt) : 0;
  const stalled = s.running && silent > STALE_MS;
  const live = s.running && !stalled;
  document.body.classList.toggle("live", live);
  document.body.classList.toggle("stalled", stalled);
  const ttl = d.project ? "lookout \u00b7 " + d.project : "lookout";
  if (el("ttl").textContent !== ttl) el("ttl").textContent = ttl;
  const phase = !s.runId ? "no run recorded yet" : stalled ? s.phase + " \u00b7 stalled" : s.phase;
  if (el("phase").textContent !== phase) el("phase").textContent = phase;
  const elapsedNode = el("el");
  if (s.startedAt){
    if (stalled) {
      elapsedNode.dataset.since = s.lastEventAt ?? undefined;
      delete elapsedNode.dataset.until;
      elapsedNode.dataset.prefix = "nothing for ";
    } else {
      elapsedNode.dataset.since = s.startedAt;
      if (s.endedAt && !s.running) elapsedNode.dataset.until = s.endedAt;
      else delete elapsedNode.dataset.until;
      elapsedNode.dataset.prefix = (s.running ? "running " : "ran for ");
    }
  }

  page.project = {
    configured: !!d.configured,
    projectDir: d.projectDir || "",
    checkRunning: !!s.checkRunning,
  };
  paintPlay();
  // A run that died says why. The server keeps the child's stderr precisely so
  // this is possible; before, the process exited into a discarded pipe.
  if (d.lastFailure) {
    say(d.lastFailure.message + (d.lastFailure.code ? " (exit " + d.lastFailure.code + ")" : ""));
  }
  paintWhere();

  const a = s.issues;
  const statsHtml =
      statFilter("state", "open", "open", a.open + a.verifying, "var(--high)")
    + statFilter("state", "blocked", "blocked", a.blocked, "var(--crit)")
    + statFilter("state", "done", "done", a.done, "var(--ok)")
    + statFilter("state", "archived", "archived", a.archived)
    + '<div class="sep"></div>'
    + statFilter("severity", "critical", "critical", s.findings.critical, "var(--crit)")
    + statFilter("severity", "high", "high", s.findings.high, "var(--high)")
    + statFilter("severity", "medium", "medium", s.findings.medium, "var(--med)")
    + statFilter("severity", "low", "low", s.findings.low, "var(--low)")
    + '<div class="sep"></div>'
    + stat("shots", s.shots)
    + (page.filter ? '<button type="button" class="stat clear" id="clearTile"'
        + ' title="show everything again (Escape)"><b>\u00d7</b><span>clear</span></button>' : "");
  paint("stats", statsHtml, statsHtml);

  // A run stops at the first route with issues and files all of them, so the
  // page says how far it got: "3 issues" means three on one route, not three
  // across an application it has mostly not looked at.
  const walked = (d.events || [])
    .filter((e) => e.kind === "note" && e.data && typeof e.data.checked === "number")
    .pop();
  const note = el("runnote");
  if (walked?.data?.found) {
    note.hidden = false;
    note.textContent = "Stopped at " + String(walked.data.route) + " after looking at "
      + String(walked.data.checked) + " of " + String(walked.data.of)
      + " routes. Fix these, then run again for the next route.";
  } else note.hidden = true;

  const bar = el("filterbar");
  if (page.filter) {
    bar.hidden = false;
    bar.innerHTML = 'Showing only <b>' + esc(page.filter.label) + '</b>';
  } else bar.hidden = true;

  const allIssues = s.board || [];
  const issues = allIssues.filter(matchesIssue);
  el("bn").textContent = allIssues.length
    ? (issues.length === allIssues.length
        ? allIssues.length + " on record"
        : issues.length + " of " + allIssues.length)
    : "";
  // Acceptance verdicts are part of the signature: a verify-fix that ticks a
  // criterion without changing anything else is exactly the moment the card
  // has to repaint, and leaving them out left it showing the old marks.
  const sig = JSON.stringify([page.filter, issues.map((b) => [b.id, b.status, b.attempt, b.verdict,
    b.shots.length, b.shots.filter((s) => s.provenance).length,
    (b.before || []).length, (b.after || []).length,
    b.lastSeenAt, (b.timeline || []).length, b.fix && b.fix.commit,
    b.archived && b.archived.reason,
    (b.acceptance || []).map((c) => c.id + c.verdict).join()])]);
  const feedTops: Record<string, number> = {};
  for (const f of document.querySelectorAll<HTMLElement>("[data-feed]")) {
    feedTops[f.dataset.feed ?? ""] = f.scrollTop;
  }
  const rebuilt = paint("board", sig, issues.length
    ? issues.map(card).join("")
    : '<div class="panel empty">'
      + (allIssues.length
          ? (page.filter ? 'Nothing is ' + esc(page.filter.label) + '.' : 'No outstanding issues.')
          : 'Nothing found yet. Run <code>lookout check</code>.')
      + '</div>');
  if (rebuilt) {
    // A feed that is talking follows its newest line the way a log tail does;
    // one nobody is writing to stays where the reader left it.
    for (const f of document.querySelectorAll<HTMLElement>("[data-feed]")) {
      const b = issues.find((x) => x.id === f.dataset.feed);
      const was = feedTops[f.dataset.feed ?? ""];
      f.scrollTop = (b && b.status === "verifying") || was === undefined ? f.scrollHeight : was;
    }
  }

  // The rail reports lookout working on itself from whichever area is open.
  // The area itself only refreshes while it is the one being read: it costs a
  // dozen file reads and a git log, and nobody is looking at it.
  paintRail(s.learning);
  if (page.view === "learning") loadLearning();

  ticks();
}

/**
 * Start a check of the project lookout is pointed at.
 *
 * Here rather than beside the button, because it is the one action that spans
 * two panels: play only ever runs, and the case it cannot handle is the one
 * where there is nothing to run, which is the cog's business.
 */
async function findAndFix(): Promise<void> {
  const btn = el("findfix") as HTMLButtonElement;
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

// Delegated, because the filter row is rebuilt whenever its numbers move.
document.addEventListener("click", (e) => {
  // The clear control is styled as a tile, so it must be taken out first: it
  // carries no kind or value, and falling into the branch below would set a
  // filter matching nothing at all.
  if (page.filter && hit(e, "#clearTile")) {
    setFilter(page.filter.kind, page.filter.value, page.filter.label);
    return;
  }
  if (hit(e, "#svClose")) { closeShot(); return; }
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
  if (hit(e, "#cog")) { toggleSettings(); return; }
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
// Tools first: the launch buttons are labelled with the chosen one, and a board
// painted before the list arrives says "open in your editor".
// Settings first: the saved project decides whether Play is even live, so
// resolving it before the first poll avoids a green button flashing grey.
// The poll is what redraws the page, so it registers itself as the refresher
// every other module asks for. Without this a filter click would change the
// state and nothing would repaint.
onRefresh(tick);

void loadConfigState().then(loadTools).then(tick);
// Enter in the URL box saves, which is what anyone typing a URL expects.
document.addEventListener("keydown", (e) => {
  const target = e.target;
  if (e.key === "Enter" && target instanceof HTMLInputElement && target.id === "setUrl") {
    e.preventDefault();
    void saveConfigState({ baseUrl: target.value });
  }
});
setInterval(() => void tick(), 1500);
setInterval(ticks, 1000);