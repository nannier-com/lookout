/**
 * The page's script: the board, the filters, the rail and the run controls.
 *
 * It is a real module now. Until this file existed the whole of it lived inside
 * a template literal in the server, which meant nothing in the build ever read
 * it: no type check, no lint, and a stray escape reached the browser as a
 * syntax error with every gate still green. Everything here is now checked
 * against the very types the server serialises, so a board field that changes
 * shape fails the build instead of the page.
 */
import { el, enc, esc, paint, repaint, slot, ticks } from "./dom.js";
import { loadLearning } from "./learning.js";
import type { BoardEntry, BoardShot } from "../../report/board.js";
import type { ToolChoice } from "../../report/handoff.js";
import type { StatusPayload } from "../payload.js";
import type { ProjectView, SettingsView } from "../project.js";

/** Which headline number the reader clicked, if any. */
interface Filter {
  kind: "state" | "severity";
  value: string;
  label: string;
}

/**
 * The element a click landed on, or the nearest one matching.
 *
 * Every listener on this page is delegated, because the regions they cover are
 * rebuilt under them several times a minute. An event target is not necessarily
 * an element (it can be the document, or a text node's owner), so this is the
 * one place that check is made.
 */
function hit(e: Event, selector: string): HTMLElement | null {
  const target = e.target;
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

const STALE_MS = 10 * 60 * 1000;

// Clicking a headline number narrows the page to the work it counts. Held here
// rather than in the URL because it is a view, not a place: a reload should
// come back to everything outstanding.
let filter: Filter | null = null;

// Which coding tool a launch opens. Remembered per browser, because it is a
// preference about the reader, not about the project.
let tools: ToolChoice[] = [];
let tool: string | null = null;
try {
  tool = localStorage.getItem("lookout.tool");
} catch {
  // A private window refuses storage. The preference is then per visit.
  tool = null;
}
function toolLabel(): string {
  const t = tools.find((x) => x.key === tool);
  return t ? t.label : "your editor";
}
function toolMark(): string {
  const t = tools.find((x) => x.key === tool);
  return t ? t.mark : "";
}
function paintToggle(): void {
  const html = tools.map((t) =>
    '<button type="button" data-tool="' + esc(t.key) + '"'
    + ' aria-pressed="' + (t.key === tool ? 'true' : 'false') + '"'
    + ' aria-label="' + esc(t.label) + '"'
    + (t.installed ? '' : ' data-missing="1"')
    + ' title="' + (t.installed ? 'open issues in ' + esc(t.label)
        : esc(t.bin) + ' is not on PATH; the command is shown so you can run it yourself')
    // The mark is markup, not text, so it is the one thing here not escaped:
    // it comes from lookout itself or from a file in the project.
    + '">' + t.mark + '</button>').join("");
  paint("toolToggle", tool + "|" + html, html);
}

const STATES: Record<string, string[]> = {
  open: ["open", "still-open", "regressed", "verifying"],
  blocked: ["blocked"],
  done: ["done"],
  archived: ["archived"],
};
// Work that is finished with is kept and reachable, but it is not what the page
// opens on: unfiltered, this is a view of what still needs doing.
const SETTLED = ["done", "archived"];

function matchesIssue(b: BoardEntry): boolean {
  if (!filter) return !SETTLED.includes(b.status);
  if (filter.kind === "state") return (STATES[filter.value] ?? []).includes(b.status);
  return b.severity === filter.value && !SETTLED.includes(b.status);
}


function setFilter(kind: Filter["kind"], value: string, label: string): void {
  const same = filter && filter.kind === kind && filter.value === value;
  filter = same ? null : { kind, value, label };
  tick();
  if (!filter) return;
  const target = el("issues");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
}

function statBody(v: number | string, l: string, c: string | undefined, zero: boolean): string {
  return '<b' + (c && !zero ? ' style="color:' + c + '"' : '') + '>' + esc(v) + '</b>'
    + '<span>' + esc(l) + '</span>';
}
function stat(l: string, v: number | string, c?: string): string {
  const zero = v === 0 || v === "0";
  return '<div class="stat' + (zero ? ' z' : '') + '">' + statBody(v, l, c, zero) + '</div>';
}
function statFilter(
  kind: Filter["kind"],
  value: string,
  l: string,
  v: number,
  c?: string,
): string {
  const zero = v === 0;
  const on = filter && filter.kind === kind && filter.value === value;
  return '<button type="button" class="stat' + (zero ? ' z' : '') + '"'
    + ' data-kind="' + esc(kind) + '" data-value="' + esc(value) + '"'
    + ' data-label="' + esc(l) + '"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
    + (zero ? ' disabled' : '')
    + ' title="' + (zero ? 'nothing to show'
        : value === "blocked"
          ? 'lookout ran out of attempts on these; they still need fixing'
          : 'show only ' + esc(l)) + '">'
    + statBody(v, l, c, zero) + '</button>';
}

function tile(s: BoardShot, w: number): string {
  return '<a class="tile" href="/evidence/' + enc(s.path) + '" target="_blank" title="' + esc(s.absPath) + '">'
    + '<img loading="lazy" src="/thumb/' + enc(s.path) + '?w=' + w + '" alt=""/>'
    + '<span>' + esc([s.formFactor, s.scheme].filter(Boolean).join(" \u00b7 ") || s.route) + '</span></a>';
}
function strip(label: string, shots: BoardShot[]): string {
  const tiles = shots.map((s) => tile(s, 264)).join("");
  if (!tiles) return "";
  return '<div class="evi"><h4>' + esc(label) + '</h4><div class="strip">' + tiles + '</div></div>';
}

/**
 * The defect and what replaced it, one pair per view.
 *
 * Paired on route, form factor and scheme, because a comparison the reader has
 * to assemble themselves out of two strips is not a comparison. A view with
 * only one side still shows: the missing half says which side is missing rather
 * than silently dropping the frame, since "there is no after for the phone" is
 * itself worth seeing.
 */
function fixStrip(b: BoardEntry): string {
  const before = b.before || [], after = b.after || [];
  if (!before.length && !after.length) return "";
  const key = (s: BoardShot): string => [s.route, s.formFactor, s.scheme, s.state || ""].join("|");
  const afterBy = new Map(after.map((s) => [key(s), s] as const));
  const seen = new Set<string>();
  const pairs: [BoardShot | null, BoardShot | null][] = [];
  for (const s of before) { pairs.push([s, afterBy.get(key(s)) ?? null]); seen.add(key(s)); }
  for (const s of after) if (!seen.has(key(s))) pairs.push([null, s]);

  const half = (s: BoardShot | null, side: string): string => s
    ? '<a class="tile side ' + side + '" href="/evidence/' + enc(s.path) + '" target="_blank"'
      + ' title="' + esc(s.absPath) + '">'
      + '<img loading="lazy" src="/thumb/' + enc(s.path) + '?w=264" alt=""/>'
      + '<b>' + side + '</b></a>'
    : '<div class="missing">no ' + side + ' frame</div>';

  const body = pairs.map(([bf, af]) => {
    // One side is always present: a pair is only made from a frame that exists.
    const s = (bf ?? af)!;
    const label = [s.formFactor, s.scheme].filter(Boolean).join(" \u00b7 ") || s.route;
    return '<div class="pair"><div class="frames">' + half(bf, "before") + half(af, "after")
      + '</div><div class="lbl">' + esc(label) + '</div></div>';
  }).join("");
  return '<div class="evi"><h4>The fix</h4><div class="pairs">' + body + '</div></div>';
}

// What lookout has recorded about this issue, oldest first.
function feed(b: BoardEntry): string {
  const steps = b.timeline || [];
  if (!steps.length) return "";
  const live = b.status === "verifying";
  const rows = steps.map((st, i) =>
    '<div class="step ' + esc(st.kind) + (live && i === steps.length - 1 ? ' now' : '') + '">'
    + '<time>' + esc(st.at.slice(0,10)) + ' ' + esc(st.at.slice(11,19)) + '</time>'
    + '<span class="t">' + esc(st.text) + '</span></div>').join("");
  return '<div class="evi"><h4>Record' + (live ? ' <em>live</em>' : '') + '</h4>'
    + '<div class="feed" data-feed="' + esc(b.id) + '">' + rows + '</div></div>';
}

// Absolute, always: the whole point of this page is handing an issue to
// somebody who then has to open these files.
function paths(b: BoardEntry): string {
  const rows = [];
  // The folder first: it holds the issue's document, its record, its
  // screenshots and its attempt history, which is the whole point of numbering
  // issues. The evidence-store paths follow for anyone who wants the originals.
  if (b.dir) rows.push(b.dir);
  for (const s of b.shots) rows.push(s.absPath);
  if (!rows.length) return "";
  return '<div class="evi"><h4>On disk</h4><div class="paths">'
    + rows.map(p => '<div>' + esc(p) + '</div>').join("") + '</div></div>';
}

// The judge's own words for every defect grouped under this root cause. A
// summary of them would be lookout paraphrasing its own evidence.
function defects(b: BoardEntry): string {
  const list = b.defects || [];
  if (!list.length) return "";
  const rows = list.map((d) =>
    '<div class="defect ' + esc(d.severity) + '">'
    + '<div class="dtitle">' + esc(d.title) + '</div>'
    + (list.length > 1 ? '<div class="dattr">' + esc(d.attribute) + '</div>' : '')
    + (d.problem ? '<p class="problem">' + esc(d.problem) + '</p>' : '')
    + '</div>').join("");
  return '<div class="evi"><h4>What is wrong'
    + (list.length > 1 ? ' <span class="n">' + list.length + ' defects</span>' : '')
    + '</h4>' + rows + '</div>';
}

// What would prove this issue fixed, and where each one stands.
//
// lookout writes these verdicts and nothing else does, so they are rendered as
// marks rather than as checkboxes: there is nothing here for a viewer to
// toggle, and no request they could send that would change one.
function acceptance(b: BoardEntry): string {
  const list = b.acceptance || [];
  if (!list.length) return "";
  const state = (v: string | null): string => v === "met" ? "met" : v === "unmet" ? "unmet"
    : v === "not-verifiable" ? "notverifiable" : "pending";
  const mark = (v: string | null): string => v === "met" ? "\u2713" : v === "unmet" ? "\u2717"
    : v === "not-verifiable" ? "\u2013" : "";
  const said = (v: string | null): string => v === "met" ? "Met." : v === "unmet" ? "Not met."
    : v === "not-verifiable" ? "Not verifiable from the evidence." : "Not checked yet.";
  const met = list.filter((c) => c.verdict === "met").length;
  const rows = list.map((c) =>
    '<li class="crit ' + state(c.verdict) + '">'
    + '<span class="box" aria-hidden="true">' + mark(c.verdict) + '</span>'
    + '<span class="ct"><span class="sr">' + said(c.verdict) + ' </span>' + esc(c.text)
    + (c.note && c.verdict !== "met" ? '<span class="cnote">' + esc(c.note) + '</span>' : '')
    + '</span></li>').join("");
  return '<div class="evi"><h4>Acceptance <span class="n">' + met + ' of ' + list.length
    + ' met</span></h4><ul class="accept" role="list">' + rows + '</ul></div>';
}

// The commit behind this issue, linked where there is somewhere to link to.
//
// The wording carries the difference lookout cares about: a commit it ruled on
// cleared the defect, and a commit somebody reported is still a claim. Saying
// "fixed in" about the second one would put lookout's name behind a verdict it
// has not reached.
function commitLine(b: BoardEntry): string {
  const f = b.fix;
  if (!f) return "";
  // "Claimed at" rather than "a fix was reported at": the line above already
  // says a fix was reported, and repeating it pushes the sha, which is the only
  // new thing here, to the end of a sentence nobody re-reads.
  const said = f.cleared ? "Fixed in" : "Claimed at";
  const sha = '<code>' + esc(f.short) + '</code>';
  const arrow = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"'
    + ' stroke-linejoin="round" d="M7 17 17 7M8 7h9v9"/></svg>';
  const body = f.url
    ? '<a href="' + esc(f.url) + '" target="_blank" rel="noreferrer noopener"'
      + ' title="open ' + esc(f.commit) + ' on ' + esc(f.host || "the remote") + '">'
      + sha + arrow + '</a><span class="host">' + esc(f.host || "") + '</span>'
    : sha + '<span class="host">no remote to link to</span>';
  return '<div class="commit">' + said + ' ' + body + '</div>';
}

function whatLine(b: BoardEntry): string {
  if (b.status === "verifying") return '<div class="what">lookout is re-judging this now.</div>';
  const n = b.attempt ? ' after ' + esc(b.attempt) + (b.attempt === 1 ? ' attempt' : ' attempts') : '';
  if (b.status === "still-open") {
    return '<div class="what">A fix was reported, but lookout still sees the defect' + n + '.</div>';
  }
  if (b.status === "blocked") {
    return '<div class="what">lookout ran out of attempts' + n + '. This one needs a person.</div>';
  }
  if (b.status === "done") return '<div class="what">lookout confirmed the defect is gone.</div>';
  if (b.status === "archived") {
    // Two different things wear this status, and calling a fix somebody filed
    // away "intentional" would credit them with a decision they never made.
    return '<div class="what">'
      + (b.archived && b.archived.reason === "fixed"
          ? "Fixed, and filed away."
          : "Adjudicated as intentional.")
      + '</div>';
  }
  return '<div class="what faint">Open. Nothing has been ruled on yet.</div>';
}

/**
 * The one control a card carries.
 *
 * A done issue has nothing to hand to a fix session, so offering to open it in
 * one is offering the wrong thing: what is left to do with a confirmed fix is
 * put it away. An archived issue gets the way back, because an archive with no
 * undo is a trapdoor.
 */
function cardAction(b: BoardEntry): string {
  const box = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none"'
    + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 6.5h18v3.2H3z"/><path d="M4.8 9.7V19h14.4V9.7"/><path d="M10 13.4h4"/></svg>';
  const back = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none"'
    + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4h4"/></svg>';

  if (b.status === "done") {
    return '<button type="button" class="filed" data-archive="' + esc(b.id) + '"'
      + ' title="File this issue away: it leaves the board and its folder moves to'
      + ' the archive. It comes back on its own if the defect returns.">'
      + box + 'Archive</button>';
  }
  if (b.status === "archived") {
    return '<button type="button" class="filed" data-archive="' + esc(b.id) + '"'
      + ' data-restore="1" title="Put this issue back on the board">'
      + back + 'Restore</button>';
  }
  return '<button type="button" class="launch" data-launch="' + esc(b.id) + '"'
    + ' aria-label="Open in ' + esc(toolLabel()) + '"'
    + ' title="Open this issue in ' + esc(toolLabel()) + '">'
    + toolMark()
    + '<svg class="go" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">'
    + '<path fill="currentColor" d="M8 5.2 19 12 8 18.8Z"/></svg>'
    + '</button>';
}

function card(b: BoardEntry): string {
  const routes = b.routes.map((r) => '<span class="chip">' + esc(r) + '</span>').join("");
  const attempt = b.attempt ? '<span class="chip">attempt ' + esc(b.attempt) + '</span>' : "";
  const seen = b.lastSeenAt
    ? '<span class="tick" data-since="' + esc(b.lastSeenAt) + '" data-prefix="seen ">\u2014</span>'
    : '<span class="tick faint">no evidence on disk</span>';
  const judge = b.judgeNote ? '<div class="note"><b>judge:</b> ' + esc(b.judgeNote) + '</div>' : "";
  return '<article class="card ' + esc(b.status) + '">'
    + '<div class="top"><span class="pill">' + esc(b.status) + '</span>'
    + '<span class="issueid" title="issue id: verify-fix --issue ' + esc(b.id) + '">'
    + esc(b.id) + '</span>' + seen + '</div>'
    + '<div class="meta">' + cardAction(b)
    + '<span class="launched" data-launched="' + esc(b.id) + '"></span></div>'
    + '<h3 class="title">' + esc(b.label) + '</h3>'
    + whatLine(b)
    + commitLine(b)
    + '<div class="meta"><span class="chip sev ' + esc(b.severity) + '">' + esc(b.severity) + '</span>'
    + '<span class="chip">' + esc(b.category) + '</span>' + routes + attempt + '</div>'
    + defects(b)
    + acceptance(b)
    // Once a fix has been ruled on, the frozen pair IS the evidence, and the
    // live strip beneath it would be the same view a second time. Before any
    // ruling, the strip is all there is. The label follows the truth in both
    // cases: after a pass, the store's copy of these views is the fixed screen,
    // so calling it "where lookout saw it" would be describing a picture of the
    // opposite of the defect.
    + ((b.after || []).length || (b.before || []).length
        ? fixStrip(b)
        : strip(b.status === "done" || b.status === "archived"
            ? "These views as they are now"
            : "Where lookout saw it", b.shots))
    + judge + feed(b) + paths(b)
    + '</article>';
}

// Where lookout is pointed, and whether it can run there at all.
let project: { configured: boolean; projectDir: string; checkRunning: boolean } =
  { configured: false, projectDir: "", checkRunning: false };

/**
 * Why the last thing you asked for did not happen.
 *
 * This exists because the reason used to be written straight into the "where"
 * element, which tick() then overwrote with the project path on its next poll.
 * Every explanation this page produced was erased within a second of appearing,
 * so picking an unusable folder looked identical to picking a fine one and
 * getting no results. Held as state instead, with tick() rendering the notice
 * when there is one and the path otherwise, so precedence is decided not raced.
 */
let notice: string | null = null;

function say(message: string | null): void {
  notice = message;
  paintWhere();
}

function paintWhere(): void {
  const where = el("where");
  const text = notice ?? project.projectDir;
  if (where.textContent !== text) where.textContent = text;
  where.title = notice ? notice + "\n\n" + project.projectDir : project.projectDir;
  where.classList.toggle("notice", notice !== null);
}

/**
 * Play, in one of three states.
 *
 * Grey until something is configured, because a green "go" that can only
 * produce an error is a lie told by a colour. Green when it would really run.
 * A turning ring while it is running.
 */
function paintPlay(): void {
  const btn = el("findfix");
  const ready = !!project.configured;
  btn.classList.toggle("busy", project.checkRunning);
  btn.classList.toggle("unset", !ready && !project.checkRunning);
  if (!btn.querySelector("svg")) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">'
      + '<path fill="currentColor" d="M8 5.2 19 12 8 18.8Z"/></svg>';
  }
  // The name lives in the accessible label and the tooltip: the control is a
  // shape, because the whole of it means "go".
  const name = project.checkRunning
    ? "looking for an issue"
    : ready ? "Find and fix" : "Nothing configured yet";
  btn.setAttribute("aria-label", name);
  btn.title = project.checkRunning
    ? "lookout is checking " + (config.projectDir || project.projectDir)
    : ready
      ? "Find and fix: one check of " + (config.projectDir || project.projectDir) +
        ", stopping at the first issue"
      : "Open settings (the cog) and choose a project first";
}

// What the settings panel is showing, so Play can refuse before it spends
// anything and the cog can render without a round trip.
let config: SettingsView = {
  configured: false,
  projectDir: null,
  baseUrl: null,
  configPath: null,
  project: null,
  targets: [],
  error: null,
};

function paintSettings(): void {
  el("setProject").textContent = config.projectDir || "not set";
  el("setProject").title = config.projectDir || "";
  const input = el("setUrl") as HTMLInputElement;
  if (document.activeElement !== input) input.value = config.baseUrl || "";
  const box = el("setTargets");
  if (config.error) {
    box.innerHTML = '<div class="tgt down">' + esc(config.error) + "</div>";
  } else if (!config.configured) {
    box.innerHTML = '<div class="tgt">Choose a folder holding .lookout/config.ts.</div>';
  } else if (!config.targets.length) {
    box.innerHTML = '<div class="tgt">That config declares no targets.</div>';
  } else {
    // Reachability here is the point of opening the panel: a wrong port shows
    // up before a run is spent on it rather than after.
    box.innerHTML = config.targets.map((t) =>
      '<div class="tgt"><b>' + esc(t.name) + "</b> " + esc(t.url) +
      "  (" + t.routes + " route" + (t.routes === 1 ? "" : "s") + ")  " +
      '<span class="' + (t.up ? "up" : "down") + '">' +
      (t.up ? "reachable" : "not responding" + (t.status ? " (HTTP " + t.status + ")" : "")) +
      "</span></div>").join("");
  }
  paintPlay();
}

async function loadConfigState(): Promise<void> {
  try {
    config = (await (await fetch("/api/settings")).json()) as SettingsView;
  } catch {
    // The server is not answering; keep showing what was last true.
    return;
  }
  project.configured = !!config.configured;
  paintSettings();
}

async function saveConfigState(body: Record<string, string>): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as SettingsView & { error?: string };
  if (data.error) { say(data.error); return; }
  config = data;
  project.configured = !!config.configured;
  say(null);
  repaint("board");
  paintSettings();
  await tick();
}

function toggleSettings(): void {
  const panel = el("settings");
  const open = panel.hidden;
  panel.hidden = !open;
  el("cog").setAttribute("aria-expanded", String(open));
  if (open) loadConfigState();
}

async function findAndFix(): Promise<void> {
  const btn = el("findfix");
  // Configuring is the cog's job. Play only ever runs, and says so plainly when
  // there is nothing to run.
  if (!project.configured) {
    say("no project configured yet: open settings and choose one");
    if (el("settings").hidden) toggleSettings();
    return;
  }
  const btnEl = btn as HTMLButtonElement;
  btnEl.disabled = true;
  try {
    const r = (await (await fetch("/api/check", { method: "POST" })).json()) as {
      started: boolean;
      reason?: string;
    };
    // A refusal names the target that is down and how to start it, so it stays
    // up until something replaces it.
    say(r.started ? null : (r.reason || "could not start"));
    await tick();
  } finally {
    btnEl.disabled = false;
  }
}

async function loadTools(): Promise<void> {
  try {
    tools = (await (await fetch("/api/tools")).json()) as ToolChoice[];
  } catch {
    tools = [];
  }
  if (!tools.some((t) => t.key === tool)) tool = tools[0]?.key ?? null;
  paintToggle();
}

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

  project = {
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
    + (filter ? '<button type="button" class="stat clear" id="clearTile"'
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
  if (filter) {
    bar.hidden = false;
    bar.innerHTML = 'Showing only <b>' + esc(filter.label) + '</b>';
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
  const sig = JSON.stringify([filter, issues.map((b) => [b.id, b.status, b.attempt, b.verdict,
    b.shots.length, (b.before || []).length, (b.after || []).length,
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
          ? (filter ? 'Nothing is ' + esc(filter.label) + '.' : 'No outstanding issues.')
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
  if (view === "learning") loadLearning();

  ticks();
}

// Which area the rail has selected. A view, not a place: a reload comes back
// to the issues, because that is what the page is normally open for.
let view = "issues";

function setView(next: string): void {
  if (view === next) return;
  view = next;
  el("viewIssues").hidden = view !== "issues";
  el("learning").hidden = view !== "learning";
  // The headline numbers are the board's filters. They go with it.
  el("stats").hidden = view !== "issues";
  for (const b of document.querySelectorAll<HTMLElement>("[data-view]")) {
    b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false");
  }
  if (view === "learning") loadLearning();
}

// The rail's dot: violet and pulsing while lookout is changing itself, amber
// while something it wrote is waiting for somebody to read it, gone otherwise.
function paintRail(b: StatusPayload["status"]["learning"] | undefined): void {
  const dot = el("railDot");
  const running = !!(b && b.running);
  const waiting = !!(b && b.proposed);
  dot.hidden = !running && !waiting;
  dot.className = running ? "rdot live" : "rdot";
  dot.title = running
    ? "lookout is working on itself right now"
    : waiting ? "an amendment lookout wrote is waiting to be read" : "";
}
// Delegated, because the filter row is rebuilt whenever its numbers move.
document.addEventListener("click", (e) => {
  // The clear control is styled as a tile, so it must be taken out first: it
  // carries no kind or value, and falling into the branch below would set a
  // filter matching nothing at all.
  if (filter && hit(e, "#clearTile")) {
    setFilter(filter.kind, filter.value, filter.label);
    return;
  }
  const area = hit(e, "[data-view]");
  if (area?.dataset.view) { setView(area.dataset.view); return; }
  const swap = hit(e, "[data-tool]");
  if (swap?.dataset.tool) {
    tool = swap.dataset.tool;
    try {
      localStorage.setItem("lookout.tool", tool);
    } catch {
      // A private window refuses storage; the choice still holds for this visit.
    }
    paintToggle();
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
      if (!picked.configured) { say("no .lookout/config.ts in " + picked.projectDir); return; }
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

async function archive(issue: string, btn: HTMLButtonElement, archived: boolean): Promise<void> {
  const out = slot('[data-launched="' + CSS.escape(issue) + '"]');
  btn.disabled = true;
  try {
    const r = await fetch("/api/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issue, archived: archived }),
    });
    const j = (await r.json()) as { error?: string };
    if (j.error) { out.textContent = j.error; btn.disabled = false; return; }
    // The board repaints from /api/status on its own tick, and the backlog was
    // just written, so the card will move on the next poll without this having
    // to reach into it.
    out.textContent = archived ? "filed away" : "back on the board";
  } catch (err) {
    out.textContent = String(err);
    btn.disabled = false;
  }
}

async function launch(issue: string, btn: HTMLButtonElement): Promise<void> {
  const out = slot('[data-launched="' + CSS.escape(issue) + '"]');
  btn.disabled = true;
  // The button is two SVGs now, so it pulses rather than swapping its text:
  // writing textContent would delete the mark and never put it back.
  btn.classList.add("busy");
  try {
    const r = await fetch("/api/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issue, tool: tool }),
    });
    const j = (await r.json()) as {
      error?: string;
      launched?: boolean;
      toolLabel?: string;
      reason?: string;
      command?: string;
    };
    if (j.error) out.textContent = j.error;
    else if (j.launched) out.textContent = "opened in " + String(j.toolLabel);
    else {
      // Say why, and hand over the command rather than failing silently.
      out.innerHTML = esc(j.reason || "could not open a terminal") + " \u00b7 run: <code>"
        + esc(j.command) + "</code>";
    }
  } catch (err) {
    out.textContent = String(err);
  }
  btn.disabled = false;
  btn.classList.remove("busy");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && filter) setFilter(filter.kind, filter.value, filter.label);
});
// Tools first: the launch buttons are labelled with the chosen one, and a board
// painted before the list arrives says "open in your editor".
// Settings first: the saved project decides whether Play is even live, so
// resolving it before the first poll avoids a green button flashing grey.
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