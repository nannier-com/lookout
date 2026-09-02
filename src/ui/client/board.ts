/**
 * One issue, as a card.
 *
 * Every card owns its evidence: the screenshots the defect was filed against,
 * the frames frozen either side of a fix, lookout's own record of what it did,
 * and every path in absolute form, because the point of the page is to hand an
 * issue to somebody who then has to go and open those files.
 */
import { enc, esc } from "./dom.js";
import { ruleLine, statusWords, verdictMark, verdictState, verdictWords } from "./card-words.js";
import { toolLabel, toolMark } from "./tools.js";
import type { BoardEntry, BoardShot } from "../../report/board.js";

/** The inspector's handle on a tile: which shot, which sidecar, what to call it. */
function shotData(s: BoardShot): string {
  const label = [s.route, s.formFactor, s.scheme, s.state].filter(Boolean).join(" \u00b7 ");
  return ' data-shot="' + esc(s.path) + '" data-label="' + esc(label) + '"'
    + (s.provenance ? ' data-prov="' + esc(s.provenance) + '"' : "");
}

function tile(s: BoardShot, w: number): string {
  const hint = s.provenance ? "\nclick to inspect where each element comes from" : "";
  return '<a class="tile" href="/evidence/' + enc(s.path) + '" target="_blank"'
    + ' title="' + esc(s.absPath + hint) + '"' + shotData(s) + '>'
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
 * This is the card's evidence, not a section that appears once something has
 * been fixed. Every issue is frozen the moment it is filed, so the pre-fix
 * frame is there from the start and the post-fix half is a placeholder saying
 * lookout has not ruled a fix on this view yet.
 *
 * Paired on route, form factor and scheme, because a comparison the reader has
 * to assemble themselves out of two strips is not a comparison. A view with
 * only one side still shows: the missing half says which side is missing, and
 * why, rather than silently dropping the frame.
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

  // A post-fix frame is only taken when lookout rules a fix passed, so its
  // absence on an open issue is the ordinary case and says so. On a settled
  // issue it means the freeze found nothing to copy, which is a different
  // sentence and a rarer one.
  const ruled = b.status === "done" || b.status === "archived";
  const absent = (side: string): string =>
    side === "post" ? (ruled ? "no post-fix screenshot kept" : "no post-fix screenshot yet")
      : "no pre-fix screenshot kept";

  const half = (s: BoardShot | null, side: string): string => s
    ? '<a class="tile side ' + side + '" href="/evidence/' + enc(s.path) + '" target="_blank"'
      + ' title="' + esc(s.absPath + (s.at ? "\nfrozen " + s.at.slice(0, 10) : "")) + '"'
      + shotData(s) + '>'
      + '<img loading="lazy" src="/thumb/' + enc(s.path) + '?w=264" alt=""/>'
      + '<b>' + side + '-fix</b></a>'
    : '<div class="missing">' + esc(absent(side)) + '</div>';

  const body = pairs.map(([bf, af]) => {
    // One side is always present: a pair is only made from a frame that exists.
    const s = (bf ?? af)!;
    const label = [s.formFactor, s.scheme].filter(Boolean).join(" \u00b7 ") || s.route;
    return '<div class="pair"><div class="frames">' + half(bf, "pre") + half(af, "post")
      + '</div><div class="lbl">' + esc(label) + '</div></div>';
  }).join("");
  return '<div class="evi"><h4>Pre and post fix</h4><div class="pairs">' + body + '</div></div>';
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
  // The frames the card is showing, which are the paths that stay put. The
  // store's own copies move under whoever opens them, so they are listed only
  // when there is nothing frozen to list instead.
  const frames = [...(b.before || []), ...(b.after || [])];
  for (const s of frames.length ? frames : b.shots) rows.push(s.absPath);
  if (!rows.length) return "";
  return '<div class="evi"><h4>On disk</h4><div class="paths">'
    + rows.map(p => '<div>' + esc(p) + '</div>').join("") + '</div></div>';
}

// The judge's own words for every defect grouped under this root cause. A
// summary of them would be lookout paraphrasing its own evidence.
// The problem text is written in two parts, the half a person reads and the
// half an agent acts on, separated by a blank line. HTML collapses that, so it
// is split back into the paragraphs it was written as. A problem that is only
// its own title again (a finding filed before lookout explained its own checks,
// and not re-captured since) is dropped rather than printed directly under the
// heading it repeats.
function problemHtml(problem: string, title: string): string {
  const text = (problem || "").trim();
  if (!text || text === (title || "").trim()) return "";
  return text.split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => '<p class="problem">' + esc(p) + '</p>')
    .join("");
}

function defects(b: BoardEntry): string {
  const list = b.defects || [];
  if (!list.length) return "";
  const rows = list.map((d) =>
    '<div class="defect ' + esc(d.severity) + '">'
    + '<div class="dtitle">' + esc(d.title) + '</div>'
    + '<div class="dattr">' + esc(ruleLine(b.category, d.attribute)) + '</div>'
    + problemHtml(d.problem, d.title)
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
  const met = list.filter((c) => c.verdict === "met").length;
  // The verdict is said in words beside the mark, since a glyph alone is a
  // code a viewer has to know: "not met" and "not ruled" are different news.
  const rows = list.map((c) =>
    '<li class="crit ' + verdictState(c.verdict) + '">'
    + '<span class="box" aria-hidden="true">' + verdictMark(c.verdict) + '</span>'
    + '<span class="cv">' + verdictWords(c.verdict) + '</span>'
    + '<span class="ct">' + esc(c.text)
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

/**
 * The issue's own document, opened in a tab.
 *
 * The card is a summary of what lookout knows; `Issue.md` is the whole of it,
 * including the standing rules, where the fix belongs, and the command that
 * rules on it. The "On disk" section names the folder that holds it, which
 * helps anyone with a terminal open and nobody reading the board on a screen
 * they cannot type into. The server hands the file over for that reason.
 *
 * Absent when there is no document to open, rather than rendered dead: an issue
 * whose folder was never written links to nothing.
 */
function docLink(b: BoardEntry): string {
  if (!b.doc) return "";
  const page = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none"'
    + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M13.5 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8Z"/>'
    + '<path d="M13.5 3v5h5"/><path d="M9 12.5h6M9 16h6"/></svg>';
  return '<a class="doc" href="/issue/' + enc(b.id) + '/Issue.md" target="_blank"'
    + ' rel="noreferrer noopener" title="' + esc(b.doc) + '">' + page + 'Issue.md</a>';
}

/**
 * The moment behind the age, for a hover.
 *
 * The chip answers "is this stale" and nothing else, and the reader who wants
 * "stale since when" had no way to ask. It is the capture's own clock: an issue
 * is only as current as the last screenshot it was filed against, and that is
 * what re-dates the chip, not anything done to the code.
 */
function seenTitle(iso: string): string {
  const t = new Date(iso);
  return "last captured " + (Number.isNaN(t.getTime()) ? iso : t.toLocaleString());
}

export function card(b: BoardEntry): string {
  const routes = b.routes.map((r) => '<span class="chip">' + esc(r) + '</span>').join("");
  const attempt = b.attempt ? '<span class="chip">attempt ' + esc(b.attempt) + '</span>' : "";
  const seen = b.lastSeenAt
    ? '<span class="tick" data-age data-since="' + esc(b.lastSeenAt) + '" data-prefix="seen "'
      + ' title="' + esc(seenTitle(b.lastSeenAt)) + '">\u2014</span>'
    : '<span class="tick faint">no evidence on disk</span>';
  const judge = b.judgeNote ? '<div class="note"><b>judge:</b> ' + esc(b.judgeNote) + '</div>' : "";
  return '<article class="card ' + esc(b.status) + '">'
    + '<div class="top"><span class="pill">' + esc(statusWords(b.status)) + '</span>'
    + '<span class="issueid" title="issue id: verify-fix --issue ' + esc(b.id) + '">'
    + esc(b.id) + '</span>' + seen + '</div>'
    + '<div class="meta">' + cardAction(b) + docLink(b)
    + '<span class="launched" data-launched="' + esc(b.id) + '"></span></div>'
    + '<h3 class="title" title="' + esc(b.label) + '">' + esc(b.title || b.label) + '</h3>'
    + whatLine(b)
    + commitLine(b)
    + '<div class="meta"><span class="chip sev ' + esc(b.severity) + '">' + esc(b.severity) + '</span>'
    + '<span class="chip" title="' + esc(b.categoryGloss ? b.categoryGloss.gloss : "") + '">'
    + esc(b.categoryGloss ? b.categoryGloss.phrase : b.category) + '</span>' + routes + attempt + '</div>'
    + defects(b)
    + acceptance(b)
    // The frozen pair IS the evidence, and the live strip beneath it would be
    // the same view a second time. The strip is what is left for an issue with
    // no frames: one filed before they existed, or one whose pixels were
    // cleaned out of the store before anything could copy them. It cannot claim
    // to be where lookout saw the defect, because the store overwrites a view
    // on every capture, so it says only what it is.
    + ((b.after || []).length || (b.before || []).length
        ? fixStrip(b)
        : strip("These views as they are now", b.shots))
    + judge + feed(b) + paths(b)
    + '</article>';
}
