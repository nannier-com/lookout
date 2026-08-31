/**
 * The second area's script: what lookout has changed about itself.
 *
 * Fetched only while that area is showing. It reads a dozen files and a git log
 * on the server, and the board's poll is already paying for whatever run is in
 * flight; the rail's own live dot rides on the status payload instead, so the
 * page can say lookout is working on itself without anybody opening this.
 */
import { el, esc, paint } from "./dom.js";
import type {
  HealAttempt,
  HealCommit,
  IncidentGroup,
  Learning,
  LearningEntry,
  SkillState,
} from "../../report/learning.js";

function when(at: string | null | undefined): string {
  if (!at) return "";
  return esc(String(at).slice(0,10)) + " " + esc(String(at).slice(11,19));
}

// What is happening this second. Both verbs hold a lock file while they run,
// which is the only honest live signal: neither writes its record until it has
// finished deciding.
function paintNow(l: Learning): void {
  const parts: string[] = [];
  if (l.running.improve) parts.push("amending its own instructions");
  if (l.running.heal) parts.push("editing its own source");
  const html = parts.length
    ? '<div class="lnow"><i></i><span><b>lookout is ' + esc(parts.join(" and ")) + '</b>'
      + ' \u00b7 nothing is kept until it passes its gate.</span></div>'
    : "";
  paint("lnow", html, html);
}

function paintSkills(l: Learning): void {
  const rows = l.instructions.skills.map((s: SkillState) =>
    '<div class="skill"><span class="nm">' + esc(s.name) + '</span>'
    + '<span class="v">v' + esc(s.version) + '</span>'
    + '<span class="ds">' + esc(s.description) + '</span>'
    + (s.amendmentPath ? '<span class="chip amended" title="' + esc(s.amendmentPath)
        + '">amended here</span>' : '')
    + (s.proposalPath ? '<span class="chip proposal" title="' + esc(s.proposalPath)
        + '">proposal waiting</span>' : '')
    + '</div>').join("");
  const html = '<div class="skills">' + (rows || '<div class="empty">No skills could be read.</div>') + '</div>';
  paint("lskills", html, html);
}

// The gate, and what is queued behind it. Said as two facts rather than as a
// status: what could grade an amendment, and what lookout would learn from next.
function paintGate(l: Learning): void {
  const f = l.instructions.frozen;
  const p = l.instructions.pending;
  const frozen = f
    ? 'Gated by <b>' + f.cases + '</b> frozen screenshot' + (f.cases === 1 ? '' : 's')
      + ' carrying <b>' + f.claims + '</b> settled claim' + (f.claims === 1 ? '' : 's')
      + ', frozen ' + when(f.frozenAt) + '.'
    : 'Nothing is frozen, so an amendment here can only be written down as a proposal. '
      + '<code>lookout skills freeze</code> builds the set out of findings already adjudicated.';
  const since = p.lastImproveAt ? ' since the last improve (' + when(p.lastImproveAt) + ')' : '';
  const pending = p.total
    ? '<div style="margin-top:6px"><b>' + p.total + '</b> new signal' + (p.total === 1 ? '' : 's')
      + since + ' ('
      + p.bySkill.map((b: { skill: string; count: number }) => esc(b.skill) + " " + b.count).join(", ")
      + '). Threshold ' + p.threshold + '; the next <code>lookout check</code> learns from them'
      + (f ? '' : ', but only as a proposal until <code>lookout skills freeze</code> builds the gate')
      + '.</div>'
    : '<div style="margin-top:6px">Nothing new to learn from' + since + ': no refutation, '
      + 'adjudication or blocked issue has been recorded since the last pass.</div>';
  const html = '<div class="' + (f ? '' : 'none') + '">' + frozen + '</div>' + pending;
  paint("lgate", html, html);
}

function paintHistory(l: Learning): void {
  const mark: Record<LearningEntry["action"], string> = { applied: "\u2713", "rolled-back": "\u21a9", proposed: "\u2026", "no-change": "\u2013" };
  const rows = l.instructions.history.map((h: LearningEntry) =>
    '<div class="lentry ' + esc(h.action) + '">'
    + '<span class="lmark" aria-hidden="true">' + (mark[h.action] || "") + '</span>'
    + '<div class="lbody"><div class="lhead2">'
    + '<span class="lact">' + esc(h.action) + '</span>'
    + '<span class="lskill">' + esc(h.skill) + (h.version ? " v" + esc(h.version) : "") + '</span>'
    + '<span class="lwhen">' + when(h.at) + '</span></div>'
    + '<div class="lsum">' + esc(h.summary || "") + '</div>'
    + ((h.violations || []).length
        ? '<div class="lwhy">' + (h.violations ?? []).map((v) =>
            '<div><code>' + esc(v.kind) + '</code> ' + esc(v.shotId) + ' \u00b7 '
            + esc(v.category) + ': ' + esc(v.why) + '</div>').join("") + '</div>'
        : '')
    + ((h.evidence ?? []).length
        ? '<div class="levi">from: ' + (h.evidence ?? []).map((e) => esc(e)).join(" \u00b7 ") + '</div>'
        : '')
    + '</div></div>').join("");
  const html = rows
    || '<div class="empty">lookout has not changed its instructions in this project yet. '
       + 'Run <code>lookout skills improve</code> once there is something settled to learn from.</div>';
  paint("lhistory", html, html);
}

function paintIncidents(l: Learning): void {
  // Words, not styling: the "hot" class used to be the page's entire account
  // of a failure worth acting on.
  const rows = l.code.incidents.map((g: IncidentGroup) => {
    const hot = g.recurred || g.count > 2;
    const state = g.needsPerson
      ? ' \u00b7 two heal attempts reverted; this one needs a person'
      : g.recurred
        ? ' \u00b7 healed before and it came back; worth a <code>lookout self-heal</code> (manual)'
        : hot
          ? ' \u00b7 recurring; worth a <code>lookout self-heal</code> (manual)'
          : '';
    return '<div class="inc' + (hot ? ' hot' : '') + '">'
      + '<span class="ct">' + esc(g.count) + '\u00d7</span>'
      + '<span class="msg">' + esc(g.message)
      + '<span class="kd"> ' + esc(g.kind) + (g.verb ? " \u00b7 during lookout " + esc(g.verb) : "")
      + " \u00b7 last " + when(g.latestAt) + state + '</span></span></div>';
  }).join("");
  const html = rows
    || '<div class="empty">Nothing has gone wrong with lookout itself on this machine.</div>';
  paint("lincidents", html, html);
}

function paintAttempts(l: Learning): void {
  const rows = l.code.attempts.map((a: HealAttempt) =>
    '<div class="lentry rolled-back">'
    + '<span class="lmark" aria-hidden="true">\u21a9</span>'
    + '<div class="lbody"><div class="lhead2">'
    + '<span class="lact">reverted</span>'
    + '<span class="lwhen">' + when(a.at) + '</span></div>'
    + '<div class="lsum">' + esc(a.summary || "The attempt left no readable report.") + '</div>'
    + (a.cause ? '<div class="levi">' + esc(a.cause) + '</div>' : '')
    + (a.failedGates.length
        ? '<div class="gates">' + a.failedGates.map((g: string) =>
            '<span class="gate-chip">' + esc(g) + ' failed</span>').join("") + '</div>'
        : '')
    + '<div class="lpath">' + esc(a.dir) + '</div>'
    + '</div></div>').join("");
  const html = '<h4 class="lwhat" style="margin:0 0 6px">Attempts a gate killed</h4>'
    + (rows || '<div class="empty">No attempt has been reverted.</div>');
  paint("lattempts", html, html);
}

function paintCommits(l: Learning): void {
  if (!l.code.checkout) {
    const html = '<div class="empty">This is an installed copy of lookout, so there is no source '
      + 'here to heal and no repository to revert in.</div>';
    paint("lcommits", html, html);
    return;
  }
  const rows = l.code.commits.map((c: HealCommit) =>
    '<div class="hcommit"><code>' + esc(c.sha) + '</code>'
    + '<span class="sj">' + esc(c.subject) + '</span>'
    + '<span class="lwhen">' + when(c.at) + '</span></div>').join("");
  const html = '<h4 class="lwhat" style="margin:0">Heals that stuck</h4>'
    + '<div class="lpath" style="margin:2px 0 8px">' + esc(l.code.checkout) + '</div>'
    + (rows || '<div class="empty">lookout has never committed a fix to itself here. '
       + 'It commits and never pushes, so any that appear are one git revert away.</div>');
  paint("lcommits", html, html);
}

function paintLearning(l: Learning): void {
  paintNow(l);
  paintSkills(l);
  paintGate(l);
  paintHistory(l);
  paintIncidents(l);
  paintCommits(l);
  paintAttempts(l);
  const applied = l.instructions.history.filter((h: LearningEntry) => h.action === "applied").length;
  el("ln1").textContent = applied
    ? applied + (applied === 1 ? " amendment kept" : " amendments kept")
    : "unchanged so far";
  const inc = l.code.incidents.reduce((n: number, g: IncidentGroup) => n + g.count, 0);
  el("ln2").textContent = inc ? inc + (inc === 1 ? " failure recorded" : " failures recorded") : "clean";
}

export async function loadLearning(): Promise<void> {
  let d: Learning | { error: string };
  try {
    d = (await (await fetch("/api/learning")).json()) as Learning | { error: string };
  } catch {
    // A poll that does not answer is not news: the area keeps what it has.
    return;
  }
  if (!("error" in d)) paintLearning(d);
}
