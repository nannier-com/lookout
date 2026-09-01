/**
 * Painting one status payload onto the page.
 *
 * This is everything the page draws from what the server says, and it is
 * separate from what decides when to draw because those are now two different
 * things: the server pushes a payload down a socket when something moves, and
 * the page also fetches one after an action it took itself. Both arrive here.
 *
 * Nothing in here asks for anything. It is handed a payload and repaints the
 * regions whose contents actually moved, which is what `paint` is for: most
 * updates change one number, and rewriting the board's innerHTML anyway would
 * throw away a reader's scroll position and text selection.
 */
import { el, esc, paint, ticks } from "./dom.js";
import { card } from "./board.js";
import { matchesIssue, stat, statFilter } from "./filters.js";
import { loadLearning } from "./learning.js";
import { paintRail, paintWhere, paintPlay, say } from "./shell.js";
import { paintToggle } from "./tools.js";
import { page } from "./state.js";
import type { StatusPayload } from "../payload.js";

const STALE_MS = 10 * 60 * 1000;

/**
 * The last run state the server described, kept so the clock can be re-read.
 *
 * Everything else on this page changes only when the server says so, which is
 * why the socket replaced the poll. Staleness is the exception: it is a
 * statement about how long ago the last event was, and it becomes true by the
 * passage of time with nothing arriving. Holding the state here is what lets
 * `runState` be re-run on a clock without asking the server anything.
 */
let lastRun: StatusPayload["status"] | null = null;

/**
 * Say whether a run is live, stalled, or over.
 *
 * lookout cannot see a process die, so a killed run leaves the log claiming it
 * is still running, forever. Silence is the only evidence available: past
 * STALE_MS with nothing said, stop animating and say how long it has been quiet
 * rather than show a live clock for a run that ended hours ago.
 *
 * Its own function, called from `render` and from the page's one-second tick,
 * because the two callers arrive for different reasons. The poll this page used
 * to run re-read the clock 40 times a minute as a side effect of asking for
 * everything else; a pushed page is told nothing at all while a run sits dead,
 * which is exactly the case this has to notice. Without the tick, a run killed
 * with -9 animates as "running" until somebody reloads.
 */
export function runState(): void {
  const s = lastRun;
  if (!s) return;
  const silent = s.lastEventAt ? Date.now() - Date.parse(s.lastEventAt) : 0;
  const stalled = s.running && silent > STALE_MS;
  const live = s.running && !stalled;
  document.body.classList.toggle("live", live);
  document.body.classList.toggle("stalled", stalled);
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
}

export function render(d: StatusPayload): void {
  paintToggle();
  const s = d.status;

  lastRun = s;
  runState();
  const ttl = d.project ? "lookout \u00b7 " + d.project : "lookout";
  if (el("ttl").textContent !== ttl) el("ttl").textContent = ttl;

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
