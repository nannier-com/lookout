/**
 * `lookout ui`: a local page showing what lookout is doing, while it does it.
 *
 * Everything lookout knows is already on disk in the event log and the evidence
 * directory, so this is a reader: a small static server plus a page that polls.
 * It starts nothing and judges nothing, which means it can be left open across
 * runs and can watch a run started by any agent in any terminal.
 *
 * The page is a board of fix sessions, not a report. A run dispatches a dozen
 * clusters to a dozen child sessions at once, and the only question a person
 * watching actually has is which of them is being worked, by whom, for how
 * long, and on what. So every card owns its own evidence: the screenshots the
 * defect was filed against, and, once a fix is claimed, the screenshots
 * `verify-fix` took afterwards. A single undifferentiated grid of every capture
 * in the run cannot answer any of that.
 *
 * No dependencies: node's own http server, and a page inlined below. Bound to
 * the loopback interface, because it serves screenshots of the user's app.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { evidenceDir, loadConfig } from "../config.js";
import { readEvents, summarise } from "../report/events.js";
import { buildBoard, tally } from "../report/board.js";
import { execFileAsync, num, str, type Parsed } from "../util.js";
import type { ResolvedConfig } from "../types.js";

/**
 * Thumbnails are re-requested every time the page re-renders a tile, and
 * re-encoding a multi-megabyte PNG each time would make the grid slower than
 * serving the originals. Keyed by path, mtime and width, so a fresh capture at
 * the same path invalidates on its own.
 */
const thumbCache = new Map<string, Buffer>();

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
};

/** Serve only from inside the evidence directory, whatever the URL claims. */
function safeEvidencePath(evDir: string, rel: string): string | null {
  const target = resolve(evDir, decodeURIComponent(rel));
  const root = resolve(evDir);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

/**
 * Briefs and contact sheets are logged as absolute paths, because the agents
 * that open them need absolute paths. The page can only serve what is under the
 * evidence directory, so hand it the relative form and let it drop anything
 * that falls outside.
 */
function evidenceRel(evDir: string, abs: string | null): string | null {
  if (!abs) return null;
  const rel = relative(resolve(evDir), resolve(abs));
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? rel.split(sep).join("/") : null;
}

/**
 * The board is derived from the backlog and one state file per cluster, which
 * is a hundred kilobytes of reads. The page polls every 1.5 seconds, so the
 * result is held until something on disk actually moves.
 */
let boardCache: { key: string; body: string } | null = null;

function diskKey(resolved: ResolvedConfig): string {
  const parts: string[] = [];
  for (const p of [
    join(lookoutRoot(resolved), "backlog.json"),
    join(evidenceDir(resolved), "events.jsonl"),
    join(evidenceDir(resolved), "fix"),
  ]) {
    try {
      const st = statSync(p);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

function lookoutRoot(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "..");
}

function handle(resolved: ResolvedConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const evDir = evidenceDir(resolved);

  if (url.pathname === "/api/status") {
    const key = diskKey(resolved);
    if (boardCache?.key === key) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(boardCache.body);
      return;
    }
    void (async () => {
      try {
        const events = readEvents(resolved);
        const status = summarise(events);
        // The board is what work exists, which lives in the backlog and the
        // per-cluster state files. The event log only says what is happening
        // this second, and every capture truncates it.
        const board = await buildBoard(resolved, events);
        // One image with every capture on it answers "what did lookout look at"
        // better than a grid of the ones nothing was filed against, and costs
        // the page a single link instead of a section.
        const sheet = join(evDir, "contact-sheet.png");
        const body = JSON.stringify({
          project: resolved.project,
          projectDir: resolved.projectDir,
          contactSheet: existsSync(sheet) ? "contact-sheet.png" : null,
          status: {
            ...status,
            board: board.map((b) => ({ ...b, sheetRel: evidenceRel(evDir, b.sheet) })),
            agents: tally(board),
          },
          events: events.slice(-400),
        });
        boardCache = { key, body };
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
      } catch (err) {
        // A malformed backlog must not take the page down; say so instead.
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
    return;
  }

  // Full-page screenshots run to megabytes each, and a grid of them stalls the
  // page for the whole run. Thumbnails are generated on demand and cropped the
  // same way the contact sheet crops, so the grid matches what the sheet shows.
  if (url.pathname.startsWith("/thumb/")) {
    const p = safeEvidencePath(evDir, url.pathname.slice("/thumb/".length));
    if (!p) {
      res.writeHead(404).end("not found");
      return;
    }
    void (async () => {
      try {
        const w = Math.min(600, Math.max(120, Number(url.searchParams.get("w") ?? 380)));
        // A screenshot is cropped to its top, which is the part that carries the
        // defect. A contact sheet is already a composite, so cropping it hides
        // the very tiles it was built to show: fit the whole thing instead.
        const whole = url.searchParams.get("fit") === "inside";
        const h = Math.round(w * (whole ? 1.2 : 0.8));
        const st = statSync(p);
        const key = `${p}|${st.mtimeMs}|${st.size}|${w}|${whole ? "in" : "cover"}`;
        const etag = `"${Buffer.from(key).toString("base64url").slice(0, 32)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304).end();
          return;
        }
        let buf = thumbCache.get(key);
        if (!buf) {
          const sharp = (await import("sharp")).default;
          buf = await sharp(p)
            .resize(w, h, {
              fit: whole ? "inside" : "cover",
              position: "top",
              withoutEnlargement: true,
            })
            .webp({ quality: 72 })
            .toBuffer();
          if (thumbCache.size > 400) thumbCache.clear();
          thumbCache.set(key, buf);
        }
        res.writeHead(200, { "content-type": "image/webp", etag, "cache-control": "no-cache" });
        res.end(buf);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
    return;
  }

  if (url.pathname.startsWith("/evidence/")) {
    const p = safeEvidencePath(evDir, url.pathname.slice("/evidence/".length));
    if (!p) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(p).pipe(res);
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
    return;
  }
  res.writeHead(404).end("not found");
}

export async function ui(parsed: Parsed): Promise<number> {
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
  });
  const port = num(parsed.flags.port) ?? 7333;
  const server = createServer((req, res) => {
    try {
      handle(resolved, req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end("error");
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });

  const href = `http://127.0.0.1:${port}/`;
  console.log(`lookout ui: ${href}`);
  console.log(`  watching ${join(resolved.projectDir, ".lookout", "evidence")}`);
  console.log("  it reads the event log, so it shows any run started anywhere, live.");
  console.log("  fix sessions appear as they are reported with `lookout agent start|done`.");
  console.log("  Ctrl-C to stop.");
  if (parsed.flags.open) {
    try {
      await execFileAsync("open", [href]);
    } catch {
      // Opening a browser is a convenience; the URL above is the contract.
    }
  }

  await new Promise<void>((done) => {
    process.on("SIGINT", () => {
      server.close();
      done();
    });
  });
  return 0;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>lookout</title>
<style>
:root{color-scheme:light dark;
--bg:#f6f7f9;--panel:#fff;--sunk:#f0f1f4;--ink:#15171c;--dim:#5f636d;--faint:#8b909b;--line:#e2e4e9;
--crit:#b4232b;--high:#c2410c;--med:#a16207;--low:#4b5563;--ok:#15803d;--accent:#4338ca;
--work:#1d4ed8;--rep:#a16207;--ver:#7c3aed;--shadow:0 1px 2px rgba(16,18,22,.06),0 4px 12px rgba(16,18,22,.05)}
@media(prefers-color-scheme:dark){:root{
--bg:#0e1014;--panel:#171a21;--sunk:#12151b;--ink:#e9eaee;--dim:#989ea9;--faint:#6d737e;--line:#252932;
--crit:#f87171;--high:#fb923c;--med:#fbbf24;--low:#9ca3af;--ok:#4ade80;--accent:#a5b4fc;
--work:#60a5fa;--rep:#fbbf24;--ver:#c4b5fd;--shadow:0 1px 2px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);
padding:12px 22px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:9}
h1{font-size:15px;margin:0;letter-spacing:.01em;font-weight:660;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);margin-right:8px;
vertical-align:middle}
.live .dot{background:var(--ok);box-shadow:0 0 0 0 var(--ok);animation:pulse 1.8s infinite}
.stalled .dot{background:var(--med);animation:none}
.stalled #phase,.stalled #el{color:var(--med)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.55)}70%{box-shadow:0 0 0 7px rgba(74,222,128,0)}
100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}
.muted{color:var(--dim)}.faint{color:var(--faint)}
.spacer{flex:1}
main{padding:20px 22px 60px;max-width:1600px;margin:0 auto}
section{margin-bottom:22px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);
margin:0 0 11px;font-weight:700;display:flex;align-items:baseline;gap:9px}
h2 .n{color:var(--dim);letter-spacing:0;text-transform:none;font-weight:500;font-size:12px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px 17px;
box-shadow:var(--shadow)}
.row{display:flex;gap:26px;flex-wrap:wrap}
.stat b{display:block;font-size:21px;font-weight:660;line-height:1.25;font-variant-numeric:tabular-nums}
.stat span{font-size:12px}
.stat.z b{color:var(--faint)}
.rule{width:1px;align-self:stretch;background:var(--line)}

/* --- the board ------------------------------------------------------- */
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:14px;
align-items:start}
@media(max-width:520px){.board{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--line);
border-radius:12px;padding:13px 15px 14px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:9px}
.card.working{border-left-color:var(--work)}
.card.verifying{border-left-color:var(--ver)}
.card.reported{border-left-color:var(--rep)}
.card.passed{border-left-color:var(--ok)}
.card\\.still-open,.card.regressed{border-left-color:var(--crit)}
.card.blocked{border-left-color:var(--crit)}
.card.passed{opacity:.72}
.top{display:flex;align-items:center;gap:9px}
.pill{font-size:10.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;
padding:3px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.working .pill{color:var(--work);border-color:var(--work)}
.verifying .pill{color:var(--ver);border-color:var(--ver)}
.reported .pill{color:var(--rep);border-color:var(--rep)}
.passed .pill{color:var(--ok);border-color:var(--ok)}
.blocked .pill,.regressed .pill{color:var(--crit);border-color:var(--crit)}
.working .pill::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
background:var(--work);margin-right:6px;vertical-align:middle;animation:pulse2 1.4s infinite}
@keyframes pulse2{50%{opacity:.2}}
.tick{margin-left:auto;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);
font-variant-numeric:tabular-nums;white-space:nowrap}
.title{font-size:14.5px;font-weight:640;margin:0;line-height:1.35;word-break:break-word}
.who{font-size:12.5px;color:var(--dim)}
.who b{color:var(--ink);font-weight:600}
.meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip{font-size:11px;padding:2px 7px;border-radius:6px;background:var(--sunk);color:var(--dim);
border:1px solid var(--line);white-space:nowrap}
.chip.critical{color:var(--crit)}.chip.high{color:var(--high)}
.chip.medium{color:var(--med)}.chip.low{color:var(--low)}
.chip.sev{font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:10px}

/* a card's own evidence, which is the point of the whole page */
.evi{margin-top:1px}
.evi h4{margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;
color:var(--faint);font-weight:700}
.strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}
.strip::-webkit-scrollbar{height:6px}
.strip::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
.tile{flex:0 0 auto;width:132px;text-decoration:none;color:inherit;display:block}
.tile img{display:block;width:132px;height:106px;object-fit:cover;object-position:top;
border:1px solid var(--line);border-radius:7px;background:var(--sunk)}
.tile.sheet img{object-fit:contain;background:var(--sunk)}
.tile:hover img{border-color:var(--accent)}
.tile span{display:block;font-size:10.5px;color:var(--faint);margin-top:4px;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note{font-size:12.5px;color:var(--dim);background:var(--sunk);border-radius:7px;padding:7px 9px;
border:1px solid var(--line)}

/* The running account of one session. A status word says where a session got
   to; this says what it has been doing, which is the thing you actually watch. */
.feed{background:var(--sunk);border:1px solid var(--line);border-radius:8px;
max-height:172px;overflow-y:auto;scrollbar-width:thin}
.feed::-webkit-scrollbar{width:6px}
.feed::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
.step{display:flex;gap:9px;padding:5px 10px;font-size:12px;line-height:1.45;
border-bottom:1px solid var(--line)}
.step:last-child{border-bottom:0}
.step time{flex:0 0 auto;color:var(--faint);font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
font-variant-numeric:tabular-nums}
.step .t{min-width:0;color:var(--dim);word-break:break-word}
.step.dispatch .t,.step.verify .t{color:var(--faint);font-style:italic}
.step.start .t{color:var(--ink)}
.step.note .t{color:var(--ink)}
.step.done .t{color:var(--rep)}
.step.verdict .t{color:var(--ink);font-weight:560}
.step.live{position:relative}
.step.live .t::after{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
background:var(--work);margin-left:7px;vertical-align:middle;animation:pulse2 1.4s infinite}
.feedhead{display:flex;align-items:baseline;gap:8px}
.feedhead h4{margin:0}
.feedhead .n{font-size:10.5px;color:var(--faint)}
.note b{color:var(--ink);font-weight:600}
.brief{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);
word-break:break-all}
.hint{font-size:12px;color:var(--faint);font-style:italic}

/* --- findings ---------------------------------------------------------
   A finding is a claim about a screenshot, so the screenshot belongs next to
   it. The old list showed a title and three words of context, which meant the
   evidence for every claim on the page lived somewhere else entirely. */
.finds{display:grid;grid-template-columns:repeat(auto-fill,minmax(500px,1fr));gap:14px;
align-items:start}
@media(max-width:560px){.finds{grid-template-columns:1fr}}
.fcard{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--line);
border-radius:12px;padding:13px 15px 14px;box-shadow:var(--shadow);display:flex;gap:14px}
@media(max-width:560px){.fcard{flex-direction:column}}
.fcard.critical{border-left-color:var(--crit)}.fcard.high{border-left-color:var(--high)}
.fcard.medium{border-left-color:var(--med)}.fcard.low{border-left-color:var(--low)}
.fshot{flex:0 0 auto;width:168px;text-decoration:none;color:inherit}
.fshot img{display:block;width:168px;height:134px;object-fit:cover;object-position:top;
border:1px solid var(--line);border-radius:8px;background:var(--sunk)}
.fshot:hover img{border-color:var(--accent)}
.fshot span{display:block;font-size:10.5px;color:var(--faint);margin-top:4px;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:560px){.fshot,.fshot img{width:100%}}
.fbody{min-width:0;display:flex;flex-direction:column;gap:7px}
.problem{margin:0;font-size:12.5px;line-height:1.5;color:var(--dim)}
.sev{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:750}
.pill.critical{color:var(--crit);border-color:var(--crit)}
.pill.high{color:var(--high);border-color:var(--high)}
.pill.medium{color:var(--med);border-color:var(--med)}
.pill.low{color:var(--low);border-color:var(--low)}

/* --- captures, log ----------------------------------------------------- */
.sheetlink{font-size:12px;color:var(--accent);text-decoration:none;border:1px solid var(--line);
border-radius:7px;padding:3px 9px}
.sheetlink:hover{border-color:var(--accent)}
.empty{color:var(--faint);font-style:italic;font-size:13px}
</style></head><body>
<header>
  <h1><span class="dot"></span><span id="ttl">lookout</span></h1>
  <span class="muted" id="phase"></span>
  <span class="spacer"></span>
  <a class="sheetlink" id="sheet" href="#" target="_blank" hidden>contact sheet</a>
  <span class="faint" id="el"></span>
</header>
<main>
<section><div class="panel"><div class="row" id="stats"></div></div></section>
<section><h2>Fix sessions <span class="n" id="bn"></span></h2><div class="board" id="board"></div></section>
<section><h2>Findings <span class="n" id="fn"></span></h2><div class="finds" id="findings"></div></section>
</main>
<script>
// A judge batch can take three minutes and a capture with a sign-in hook
// longer, so this is deliberately generous: it catches killed runs, not slow
// ones. Kept in step with STALE_MS in verbs/status.ts.
const STALE_MS = 10 * 60 * 1000;
const last = {};
// Re-rendering a section on every poll restarts every image request inside it,
// which on a 1.5s interval means a thumbnail never finishes loading. Only touch
// a section when its content actually changed.
function paint(id, sig, html){
  if (last[id] === sig) return false;
  last[id] = sig; el(id).innerHTML = html; return true;
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const el = id => document.getElementById(id);
const enc = p => String(p).split("/").map(encodeURIComponent).join("/");
function stat(l, v, c){
  const zero = (v === 0 || v === "0");
  return '<div class="stat' + (zero ? ' z' : '') + '"><b'+(c && !zero ?' style="color:'+c+'"':'')+'>'
    + esc(v)+'</b><span class="muted">'+esc(l)+'</span></div>';
}

// Elapsed times tick once a second, but re-rendering a card to advance a clock
// would restart its thumbnails. The clocks are updated in place instead.
function dur(ms){
  const s = Math.max(0, Math.round(ms/1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s/60);
  if (m < 60) return m + "m" + String(s%60).padStart(2,"0") + "s";
  return Math.floor(m/60) + "h" + String(m%60).padStart(2,"0") + "m";
}
function ticks(){
  for (const n of document.querySelectorAll("[data-since]")){
    const to = n.dataset.until ? Date.parse(n.dataset.until) : Date.now();
    n.textContent = (n.dataset.prefix || "") + dur(to - Date.parse(n.dataset.since));
  }
}

function tile(s, w){
  return '<a class="tile" href="/evidence/' + enc(s.path) + '" target="_blank" title="' + esc(s.path) + '">'
    + '<img loading="lazy" src="/thumb/' + enc(s.path) + '?w=' + w + '" alt=""/>'
    + '<span>' + esc([s.formFactor, s.scheme].filter(Boolean).join(" \\u00b7 ") || s.route) + '</span></a>';
}
function strip(label, shots, sheetRel){
  const tiles = shots.map(s => tile(s, 264)).join("");
  const sheet = sheetRel
    ? '<a class="tile sheet" href="/evidence/' + enc(sheetRel) + '" target="_blank" title="contact sheet">'
      + '<img loading="lazy" src="/thumb/' + enc(sheetRel) + '?w=264&fit=inside" alt=""/>'
      + '<span>all of it, one sheet</span></a>'
    : "";
  if (!tiles && !sheet) return "";
  return '<div class="evi"><h4>' + esc(label) + '</h4><div class="strip">' + sheet + tiles + '</div></div>';
}

// What the card says about its session, in words rather than a bare state name.
function whoLine(b){
  const a = b.agent;
  if (b.status === "queued") {
    return '<div class="who hint">No fix session has been reported on this yet.</div>';
  }
  if (!a) {
    // No session was ever reported against this cluster, but lookout may still
    // have ruled on it. Say what that means for the reader rather than echoing
    // the status word that is already in the pill above.
    const n = b.attempt ? ' on attempt ' + esc(b.attempt) : '';
    if (b.status === "still-open") {
      return '<div class="who">lookout handed this back' + n + '. It needs a fresh session.</div>';
    }
    if (b.status === "regressed") {
      return '<div class="who">A fix here introduced new defects' + n
        + '. It needs a fresh session.</div>';
    }
    if (b.status === "blocked") {
      return '<div class="who">Out of attempts' + n + '. lookout will not dispatch it again.</div>';
    }
    if (b.status === "verifying") return '<div class="who">lookout is re-judging this now.</div>';
    if (b.status === "passed") return '<div class="who">Confirmed fixed.</div>';
    return '<div class="who faint">' + esc(b.status) + '</div>';
  }
  const clock = '<span data-since="' + esc(a.startedAt) + '"'
    + (a.finishedAt ? ' data-until="' + esc(a.finishedAt) + '"' : '') + '>\\u2014</span>';
  // Sessions are normally named after the cluster they were handed, so naming
  // one here would print the card's own title back at it.
  const who = a.name && a.name !== b.label ? '<b>' + esc(a.name) + '</b>' : 'A fix session';
  if (b.status === "working") return '<div class="who">' + who + ' has been on this for ' + clock + '.</div>';
  if (b.status === "verifying") {
    return '<div class="who">' + who + ' worked it for ' + clock
      + '. <b>verify-fix</b> is re-judging it now.</div>';
  }
  if (b.status === "reported") {
    return '<div class="who">' + who + ' worked it for ' + clock
      + ', then reported back. Awaiting <b>verify-fix</b>.</div>';
  }
  if (b.status === "passed") return '<div class="who">' + who + ' fixed it in ' + clock + '.</div>';
  if (b.status === "blocked") {
    return '<div class="who">' + who + ' spent ' + clock + ' on it and ran out of attempts.</div>';
  }
  return '<div class="who">' + who + ' worked it for ' + clock
    + ', and the defect is still there.</div>';
}

// The running account of one cluster. The last line of a live session is
// marked, because "what is it doing right now" is the question this answers.
function feed(b){
  const steps = b.timeline || [];
  if (!steps.length) return "";
  const live = b.status === "working";
  const rows = steps.map((st, i) => {
    const isLast = i === steps.length - 1;
    return '<div class="step ' + esc(st.kind) + (live && isLast ? ' live' : '') + '">'
      + '<time>' + esc(st.at.slice(11,19)) + '</time>'
      + '<span class="t">' + esc(st.text) + '</span></div>';
  }).join("");
  return '<div class="evi">'
    + '<div class="feedhead"><h4>Activity</h4><span class="n">' + steps.length + ' step'
    + (steps.length === 1 ? '' : 's') + '</span></div>'
    + '<div class="feed" data-feed="' + esc(b.id) + '">' + rows + '</div></div>';
}

function card(b){
  const routes = b.routes.map(r => '<span class="chip">' + esc(r) + '</span>').join("");
  const attempt = b.attempt ? '<span class="chip">attempt ' + esc(b.attempt) + '</span>' : "";
  const amended = b.amended ? '<span class="chip">amended</span>' : "";
  const commit = b.agent && b.agent.commit
    ? '<span class="chip">' + esc(String(b.agent.commit).slice(0,10)) + '</span>' : "";
  // The judge's ruling is repeated outside the feed: it is the one line that
  // decides whether this cluster needs another session, and it must not be
  // something you have to scroll a feed to find.
  const judge = b.judgeNote ? '<div class="note"><b>judge:</b> ' + esc(b.judgeNote) + '</div>' : "";
  return '<article class="card ' + esc(b.status) + '">'
    + '<div class="top"><span class="pill">' + esc(b.status) + '</span>'
    + (b.dispatchedAt
        ? '<span class="tick" data-since="' + esc(b.dispatchedAt) + '" data-prefix="dispatched ">\\u2014</span>'
        : '<span class="tick faint">not dispatched yet</span>')
    + '</div>'
    + '<h3 class="title">' + esc(b.label) + '</h3>'
    + whoLine(b)
    + '<div class="meta"><span class="chip sev ' + esc(b.severity) + '">' + esc(b.severity) + '</span>'
    + '<span class="chip">' + esc(b.category) + '</span>' + routes + attempt + amended + commit + '</div>'
    + strip("What this session is fixing", b.shots, b.sheetRel)
    + strip("What verify-fix saw afterwards", b.recheck, null)
    + feed(b) + judge
    + '<div class="brief">' + esc(b.brief) + '</div>'
    + '</article>';
}

// A finding names one screenshot, and a dispatched cluster carries the
// screenshots it was filed against, so the two can be matched back up. The card
// then says which session owns the defect rather than leaving the reader to
// pair a category and a route by eye.
function ownerOf(x, board){
  const hits = board.filter(b => b.category === x.category
    && (b.shots.some(s => s.path === x.path) || b.recheck.some(s => s.path === x.path)));
  return hits.length === 1 ? hits[0] : null;
}

function findingCard(e, board){
  const x = e.data || {};
  const title = e.message.replace(/^[^:]*:\\s*/, "");
  const shot = x.path
    ? '<a class="fshot" href="/evidence/' + enc(x.path) + '" target="_blank" title="' + esc(x.path) + '">'
      + '<img loading="lazy" src="/thumb/' + enc(x.path) + '?w=336" alt=""/>'
      + '<span>' + esc([x.formFactor, x.scheme].filter(Boolean).join(" \\u00b7 ")) + '</span></a>'
    : "";
  const owner = ownerOf(x, board);
  const chips = [x.route, x.formFactor, x.scheme].filter(Boolean)
    .map(v => '<span class="chip">' + esc(v) + '</span>').join("");
  const verified = x.verified
    ? '<span class="chip" title="a second pass was asked to refute this, and could not">verified</span>'
    : "";
  const own = owner
    ? '<div class="who faint">Owned by <b>' + esc(owner.label) + '</b> \\u00b7 ' + esc(owner.status) + '</div>'
    : "";
  return '<article class="fcard ' + esc(x.severity) + '">' + shot
    + '<div class="fbody">'
    + '<div class="top"><span class="pill ' + esc(x.severity) + '">' + esc(x.severity) + '</span></div>'
    + '<h3 class="title">' + esc(title) + '</h3>'
    + '<div class="meta"><span class="chip">' + esc(x.category) + "/" + esc(x.attribute) + '</span>'
    + chips + verified + '</div>'
    + (x.problem ? '<p class="problem">' + esc(x.problem) + '</p>' : "")
    + own
    + '</div></article>';
}

async function tick(){
  let d; try { d = await (await fetch("/api/status")).json(); } catch { return; }
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
  const ttl = d.project ? "lookout \\u00b7 " + d.project : "lookout";
  if (el("ttl").textContent !== ttl) el("ttl").textContent = ttl;
  const phase = !s.runId ? "no run recorded yet"
    : stalled ? s.phase + " \\u00b7 stalled" : s.phase;
  if (el("phase").textContent !== phase) el("phase").textContent = phase;
  const elapsedNode = el("el");
  if (s.startedAt){
    if (stalled) {
      elapsedNode.dataset.since = s.lastEventAt;
      delete elapsedNode.dataset.until;
      elapsedNode.dataset.prefix = "nothing for ";
    } else {
      elapsedNode.dataset.since = s.startedAt;
      if (s.endedAt && !s.running) elapsedNode.dataset.until = s.endedAt;
      else delete elapsedNode.dataset.until;
      elapsedNode.dataset.prefix = (s.running ? "running " : "ran for ");
    }
  }

  const a = s.agents;
  const statsHtml =
      stat("working", a.working, "var(--work)")
    + stat("reported back", a.reported, "var(--rep)")
    + stat("awaiting a session", a.queued)
    + stat("settled", a.resolved, "var(--ok)")
    + '<div class="rule"></div>'
    + stat("shots", s.shots)
    + stat("batches", s.batches.total ? s.batches.done + "/" + s.batches.total : "\\u2014")
    + stat("critical", s.findings.critical, "var(--crit)")
    + stat("high", s.findings.high, "var(--high)")
    + stat("medium", s.findings.medium, "var(--med)")
    + stat("low", s.findings.low, "var(--low)");
  paint("stats", statsHtml, statsHtml);

  const board = s.board || [];
  el("bn").textContent = board.length ? board.length + " dispatched" : "";
  // The signature carries everything a card renders, so a card is rebuilt when
  // its session moves and left alone (thumbnails intact) when it does not.
  const sig = JSON.stringify(board.map(b => [b.id, b.status, b.attempt, b.verdict,
    b.shots.length, b.recheck.length, b.sheetRel,
    (b.timeline || []).length, (b.timeline || []).map(t => t.at).slice(-1),
    b.agent && [b.agent.name, b.agent.startedAt, b.agent.finishedAt, b.agent.notes.length]]));
  const feedTops = {};
  for (const f of document.querySelectorAll("[data-feed]")) feedTops[f.dataset.feed] = f.scrollTop;
  const rebuilt = paint("board", sig, board.length
    ? board.map(card).join("")
    : '<div class="panel empty">Nothing dispatched yet. Run <code>lookout check --auto</code>.</div>');
  if (rebuilt) {
    // Keep each feed where the reader left it, except a live one, which follows
    // its newest line the way a log tail does.
    for (const f of document.querySelectorAll("[data-feed]")) {
      const b = board.find(x => x.id === f.dataset.feed);
      const was = feedTops[f.dataset.feed];
      f.scrollTop = (b && b.status === "working") || was === undefined
        ? f.scrollHeight
        : was;
    }
  }

  // Worst first, and newest first within a severity. Reverse-chronological
  // alone put a low-severity nit above three criticals, which is the opposite
  // of the order somebody triaging them needs.
  const SEV = {critical: 0, high: 1, medium: 2, low: 3};
  const finds = d.events.filter(e => e.kind === "finding")
    .map((e, i) => [e, i])
    .sort((a, b) => (SEV[a[0].data && a[0].data.severity] ?? 9)
                  - (SEV[b[0].data && b[0].data.severity] ?? 9) || b[1] - a[1])
    .map(pair => pair[0]);
  el("fn").textContent = finds.length ? finds.length + " filed" : "";
  // Keyed on what the cards actually draw, not just how many there are: a
  // count-only signature leaves a re-judged finding showing its old prose.
  paint("findings", JSON.stringify([
      finds.map(e => [e.data && e.data.path, e.data && e.data.attribute,
                      e.data && e.data.severity, e.message]),
      board.map(b => [b.id, b.status])]),
    finds.length
      ? finds.map(e => findingCard(e, board)).join("")
      : '<div class="panel empty">No findings yet.</div>');

  const sheetLink = el("sheet");
  if (d.contactSheet) {
    sheetLink.href = "/evidence/" + enc(d.contactSheet);
    sheetLink.hidden = false;
  } else sheetLink.hidden = true;

  ticks();
}
tick(); setInterval(tick, 1500); setInterval(ticks, 1000);
</script></body></html>`;
