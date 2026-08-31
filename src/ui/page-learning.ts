/**
 * The page's second area: lookout working on lookout.
 *
 * The board answers "what is wrong with the application". This answers the
 * other question lookout can be asked, and until now could only be answered by
 * reading files nobody knows to open: what has lookout changed about ITSELF.
 * Two verbs do that. `skills improve` amends the instructions the judge runs
 * on, gated by screenshots whose verdicts were settled before the amendment
 * existed. `self-heal` edits lookout's own TypeScript, gated by the type check,
 * the linter, the tests and the build, and reverted whole when any of them
 * fails.
 *
 * Both are the sort of thing you want to be able to look at. An agent editing
 * its own instructions is exactly the change a person should be able to read
 * afterwards, and the record of one that was rolled back is worth as much as
 * the record of one that stuck: it says the gate did its job.
 *
 * It lives in its own module because one screen's worth of markup, style and
 * script does not belong inlined in the middle of the page that carries the
 * shell, the run state and the board.
 *
 * The three exports are spliced into the single page `ui.ts` serves, so the
 * script here shares that page's helpers rather than redefining them: `esc`,
 * `el` and `paint` are defined once, above, and used here. No backticks and no
 * dollar-brace anywhere in the strings: they are interpolated into a template
 * literal on the way out.
 */

/** Styles for the learning area. Tokens are the page's; nothing new is named. */
export const LEARNING_CSS = `
/* --- what lookout has changed about itself ----------------------------- */
/* min() rather than a bare floor: a column that cannot go under 430px is wider
   than a phone once the rail has taken its 46, and the page scrolled sideways. */
.lcols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(430px,100%),1fr));
gap:18px;align-items:start}
.ltrack{display:flex;flex-direction:column;gap:12px}
.ltrack>h2{margin:0}
/* A track's opening sentence: what this half of the page is, in one line, so
   the columns are not two unlabelled lists of nouns. */
.lwhat{font-size:12.5px;color:var(--dim);margin:-4px 0 0;max-width:64ch}
.lwhat code{font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--sunk);
border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--ink);
white-space:nowrap}
/* Running right now: the one thing on this page that is not history. */
.lnow{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ver);
border:1px solid var(--ver);border-radius:10px;padding:9px 13px;background:var(--panel);
margin:0 0 16px}
.lnow i{width:8px;height:8px;border-radius:50%;background:var(--ver);flex:0 0 auto;
animation:pulse2 1.4s infinite}
.lnow b{font-weight:640;color:var(--ink)}

/* The skills themselves: what version this project judges at, and whether it
   has written anything of its own into them. */
.skills{display:flex;flex-direction:column;gap:0}
.skill{display:flex;align-items:baseline;gap:9px;padding:7px 0;border-bottom:1px solid var(--line);
flex-wrap:wrap}
.skill:last-child{border-bottom:0}
.skill .nm{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
font-weight:600}
.skill .v{font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
.skill .ds{font-size:12px;color:var(--dim);flex:1 1 240px;min-width:0}
.chip.amended{color:var(--accent);border-color:var(--accent)}
.chip.proposal{color:var(--med);border-color:var(--med)}

/* The gate, stated as a fact about evidence rather than as a setting. */
.gate{font-size:12.5px;color:var(--dim);line-height:1.5}
.gate b{color:var(--ink);font-weight:620}
.gate.none{color:var(--med)}

/* One thing lookout did to itself. The mark carries the outcome, because the
   outcome is the only reason to read the row. */
.lentry{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.lentry:last-child{border-bottom:0}
.lmark{flex:0 0 auto;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--line);
display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1;
color:var(--faint);margin-top:1px}
.lentry.applied .lmark{border-color:var(--ok);color:var(--ok)}
.lentry.rolled-back .lmark{border-color:var(--crit);color:var(--crit)}
.lentry.proposed .lmark{border-color:var(--med);color:var(--med)}
.lbody{min-width:0;flex:1 1 auto}
.lhead2{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.lact{font-size:10.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}
.applied .lact{color:var(--ok)}
.rolled-back .lact{color:var(--crit)}
.proposed .lact{color:var(--med)}
.no-change .lact{color:var(--faint)}
.lskill{font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.lwhen{margin-left:auto;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.lsum{font-size:13px;line-height:1.5;margin-top:2px;word-break:break-word}
/* Why a rollback happened: the settled verdict the candidate broke. Kept in
   full, because it is the whole argument for the gate existing. */
.lwhy{margin-top:6px;font-size:12px;color:var(--dim);background:var(--sunk);
border:1px solid var(--line);border-left:2px solid var(--crit);border-radius:7px;padding:6px 9px}
.lwhy div+div{margin-top:5px}
.lwhy code{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
.levi{margin-top:5px;font-size:11.5px;color:var(--faint);word-break:break-word}

/* A failure lookout keeps hitting. The count is the point: once is noise, nine
   times is a bug with a shape. */
.inc{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);align-items:baseline}
.inc:last-child{border-bottom:0}
.inc .ct{flex:0 0 auto;font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
font-variant-numeric:tabular-nums;color:var(--ink);background:var(--sunk);border:1px solid var(--line);
border-radius:6px;padding:2px 7px}
.inc .msg{min-width:0;font-size:12.5px;line-height:1.45;word-break:break-word}
.inc .kd{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint)}
.inc.hot .ct{color:var(--crit);border-color:var(--crit)}

/* A commit lookout wrote about itself, and an attempt that never became one. */
.hcommit{display:flex;align-items:baseline;gap:9px;padding:7px 0;
border-bottom:1px solid var(--line)}
.hcommit:last-child{border-bottom:0}
.hcommit code{font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:2px 6px;
flex:0 0 auto;user-select:all}
.hcommit .sj{font-size:12.5px;min-width:0;word-break:break-word}
.gates{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
.gate-chip{font:10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 6px;
border-radius:5px;border:1px solid var(--crit);color:var(--crit)}
.lpath{font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);
word-break:break-all;user-select:all;margin-top:4px}
`;

/** The area itself, hidden until the rail selects it. */
export const LEARNING_HTML = `
<section id="learning" hidden>
  <div id="lnow"></div>
  <div class="lcols">
    <div class="ltrack">
      <h2>Its instructions <span class="n" id="ln1"></span></h2>
      <p class="lwhat">Every judgement lookout makes is an instruction file it can amend.
        <code>lookout skills improve</code> reads what this project has settled, writes an
        amendment, and keeps it only if screenshots whose verdicts were decided beforehand
        still come out the same.</p>
      <div class="panel" id="lskills"></div>
      <div class="panel gate" id="lgate"></div>
      <div class="panel" id="lhistory"></div>
    </div>
    <div class="ltrack">
      <h2>Its own code <span class="n" id="ln2"></span></h2>
      <p class="lwhat">What has actually gone wrong with lookout, pooled across every project
        on this machine. <code>lookout self-heal</code> reads it, edits lookout's own source,
        and reverts the whole change unless the type check, the linter, the tests and the
        build all pass.</p>
      <div class="panel" id="lincidents"></div>
      <div class="panel" id="lattempts"></div>
      <div class="panel" id="lcommits"></div>
    </div>
  </div>
</section>
`;

/**
 * The client script for the area.
 *
 * Fetched only while the area is showing: it reads a dozen files and a git log,
 * and the board's poll is already paying for the run in flight. The rail's own
 * live dot comes from the status payload instead, which carries the one-line
 * version on every poll whichever area is open.
 */
export const LEARNING_JS = `
let learning = null;

function when(at){
  if (!at) return "";
  return esc(String(at).slice(0,10)) + " " + esc(String(at).slice(11,19));
}

// What is happening this second. Both verbs hold a lock file while they run,
// which is the only honest live signal: neither writes its record until it has
// finished deciding.
function paintNow(l){
  const parts = [];
  if (l.running.improve) parts.push("amending its own instructions");
  if (l.running.heal) parts.push("editing its own source");
  const html = parts.length
    ? '<div class="lnow"><i></i><span><b>lookout is ' + esc(parts.join(" and ")) + '</b>'
      + ' \\u00b7 nothing is kept until it passes its gate.</span></div>'
    : "";
  paint("lnow", html, html);
}

function paintSkills(l){
  const rows = l.instructions.skills.map(s =>
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
function paintGate(l){
  const f = l.instructions.frozen;
  const p = l.instructions.pending;
  const frozen = f
    ? 'Gated by <b>' + f.cases + '</b> frozen screenshot' + (f.cases === 1 ? '' : 's')
      + ' carrying <b>' + f.claims + '</b> settled claim' + (f.claims === 1 ? '' : 's')
      + ', frozen ' + when(f.frozenAt) + '.'
    : 'Nothing is frozen, so an amendment here can only be written down as a proposal. '
      + '<code>lookout skills freeze</code> builds the set out of findings already adjudicated.';
  const pending = p.total
    ? '<div style="margin-top:6px">Waiting to be learned from: <b>' + p.total + '</b> signal'
      + (p.total === 1 ? '' : 's') + ' ('
      + p.bySkill.map(b => esc(b.skill) + " " + b.count).join(", ") + ').</div>'
    : '<div style="margin-top:6px">Nothing new to learn from yet: no refutation, adjudication '
      + 'or blocked issue has been recorded since the last pass.</div>';
  const html = '<div class="' + (f ? '' : 'none') + '">' + frozen + '</div>' + pending;
  paint("lgate", html, html);
}

function paintHistory(l){
  const mark = { applied: "\\u2713", "rolled-back": "\\u21a9", proposed: "\\u2026", "no-change": "\\u2013" };
  const rows = l.instructions.history.map(h =>
    '<div class="lentry ' + esc(h.action) + '">'
    + '<span class="lmark" aria-hidden="true">' + (mark[h.action] || "") + '</span>'
    + '<div class="lbody"><div class="lhead2">'
    + '<span class="lact">' + esc(h.action) + '</span>'
    + '<span class="lskill">' + esc(h.skill) + (h.version ? " v" + esc(h.version) : "") + '</span>'
    + '<span class="lwhen">' + when(h.at) + '</span></div>'
    + '<div class="lsum">' + esc(h.summary || "") + '</div>'
    + ((h.violations || []).length
        ? '<div class="lwhy">' + h.violations.map(v =>
            '<div><code>' + esc(v.kind) + '</code> ' + esc(v.shotId) + ' \\u00b7 '
            + esc(v.category) + ': ' + esc(v.why) + '</div>').join("") + '</div>'
        : '')
    + ((h.evidence || []).length
        ? '<div class="levi">from: ' + h.evidence.map(esc).join(" \\u00b7 ") + '</div>'
        : '')
    + '</div></div>').join("");
  const html = rows
    || '<div class="empty">lookout has not changed its instructions in this project yet. '
       + 'Run <code>lookout skills improve</code> once there is something settled to learn from.</div>';
  paint("lhistory", html, html);
}

function paintIncidents(l){
  const rows = l.code.incidents.map(g =>
    '<div class="inc' + (g.count > 2 ? ' hot' : '') + '">'
    + '<span class="ct">' + esc(g.count) + '\\u00d7</span>'
    + '<span class="msg">' + esc(g.message)
    + '<span class="kd"> ' + esc(g.kind) + (g.verb ? " \\u00b7 during lookout " + esc(g.verb) : "")
    + " \\u00b7 last " + when(g.latestAt) + '</span></span></div>').join("");
  const html = rows
    || '<div class="empty">Nothing has gone wrong with lookout itself on this machine.</div>';
  paint("lincidents", html, html);
}

function paintAttempts(l){
  const rows = l.code.attempts.map(a =>
    '<div class="lentry rolled-back">'
    + '<span class="lmark" aria-hidden="true">\\u21a9</span>'
    + '<div class="lbody"><div class="lhead2">'
    + '<span class="lact">reverted</span>'
    + '<span class="lwhen">' + when(a.at) + '</span></div>'
    + '<div class="lsum">' + esc(a.summary || "The attempt left no readable report.") + '</div>'
    + (a.cause ? '<div class="levi">' + esc(a.cause) + '</div>' : '')
    + (a.failedGates.length
        ? '<div class="gates">' + a.failedGates.map(g =>
            '<span class="gate-chip">' + esc(g) + ' failed</span>').join("") + '</div>'
        : '')
    + '<div class="lpath">' + esc(a.dir) + '</div>'
    + '</div></div>').join("");
  const html = '<h4 class="lwhat" style="margin:0 0 6px">Attempts a gate killed</h4>'
    + (rows || '<div class="empty">No attempt has been reverted.</div>');
  paint("lattempts", html, html);
}

function paintCommits(l){
  if (!l.code.checkout) {
    const html = '<div class="empty">This is an installed copy of lookout, so there is no source '
      + 'here to heal and no repository to revert in.</div>';
    paint("lcommits", html, html);
    return;
  }
  const rows = l.code.commits.map(c =>
    '<div class="hcommit"><code>' + esc(c.sha) + '</code>'
    + '<span class="sj">' + esc(c.subject) + '</span>'
    + '<span class="lwhen">' + when(c.at) + '</span></div>').join("");
  const html = '<h4 class="lwhat" style="margin:0">Heals that stuck</h4>'
    + '<div class="lpath" style="margin:2px 0 8px">' + esc(l.code.checkout) + '</div>'
    + (rows || '<div class="empty">lookout has never committed a fix to itself here. '
       + 'It commits and never pushes, so any that appear are one git revert away.</div>');
  paint("lcommits", html, html);
}

function paintLearning(l){
  learning = l;
  paintNow(l);
  paintSkills(l);
  paintGate(l);
  paintHistory(l);
  paintIncidents(l);
  paintCommits(l);
  paintAttempts(l);
  const applied = l.instructions.history.filter(h => h.action === "applied").length;
  el("ln1").textContent = applied
    ? applied + (applied === 1 ? " amendment kept" : " amendments kept")
    : "unchanged so far";
  const inc = l.code.incidents.reduce((n, g) => n + g.count, 0);
  el("ln2").textContent = inc ? inc + (inc === 1 ? " failure recorded" : " failures recorded") : "clean";
}

async function loadLearning(){
  let d;
  try { d = await (await fetch("/api/learning")).json(); } catch { return; }
  if (d && !d.error) paintLearning(d);
}
`;
