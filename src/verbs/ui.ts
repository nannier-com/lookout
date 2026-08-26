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

function handle(resolved: ResolvedConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const evDir = evidenceDir(resolved);

  if (url.pathname === "/api/status") {
    const events = readEvents(resolved);
    const status = summarise(events);
    const body = JSON.stringify({
      project: resolved.project,
      projectDir: resolved.projectDir,
      status: {
        ...status,
        board: status.board.map((b) => ({ ...b, sheetRel: evidenceRel(evDir, b.sheet) })),
      },
      events: events.slice(-400),
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
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
.note b{color:var(--ink);font-weight:600}
.brief{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);
word-break:break-all}
.hint{font-size:12px;color:var(--faint);font-style:italic}

/* --- findings, captures, log ----------------------------------------- */
.f{border-left:3px solid var(--line);padding:7px 0 7px 12px;margin-bottom:9px}
.f:last-child{margin-bottom:0}
.f.critical{border-color:var(--crit)}.f.high{border-color:var(--high)}
.f.medium{border-color:var(--med)}.f.low{border-color:var(--low)}
.sev{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:750}
.critical>.sev{color:var(--crit)}.high>.sev{color:var(--high)}
.medium>.sev{color:var(--med)}.low>.sev{color:var(--low)}
details>summary{cursor:pointer;font-size:12px;color:var(--dim);list-style:none;
padding:2px 0;user-select:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"\\25b8 ";color:var(--faint)}
details[open]>summary::before{content:"\\25be "}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:11px;margin-top:11px}
.shots img{width:100%;height:118px;object-fit:cover;object-position:top;border:1px solid var(--line);
border-radius:7px;background:var(--sunk)}
.shots a{text-decoration:none;color:inherit;display:block}
.cap{font-size:10.5px;color:var(--faint);margin-top:4px;overflow:hidden;text-overflow:ellipsis;
white-space:nowrap}
.log{max-height:260px;overflow:auto;font:11.5px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace}
.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{color:var(--accent);display:inline-block;min-width:82px}
.empty{color:var(--faint);font-style:italic;font-size:13px}
</style></head><body>
<header>
  <h1><span class="dot"></span><span id="ttl">lookout</span></h1>
  <span class="muted" id="phase"></span>
  <span class="spacer"></span>
  <span class="faint" id="el"></span>
</header>
<main>
<section><div class="panel"><div class="row" id="stats"></div></div></section>
<section><h2>Fix sessions <span class="n" id="bn"></span></h2><div class="board" id="board"></div></section>
<section><h2>Findings <span class="n" id="fn"></span></h2><div class="panel" id="findings"></div></section>
<section><div class="panel"><details id="othersWrap">
  <summary id="othersSum">Every other capture in this run</summary>
  <div class="shots" id="others"></div></details></div></section>
<section><h2>Activity</h2><div class="panel"><div class="log" id="log"></div></div></section>
</main>
<script>
const last = {};
// Re-rendering a section on every poll restarts every image request inside it,
// which on a 1.5s interval means a thumbnail never finishes loading. Only touch
// a section when its content actually changed.
function paint(id, sig, html){ if (last[id] === sig) return; last[id] = sig; el(id).innerHTML = html; }
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
  if (!a) return '<div class="who faint">' + esc(b.status) + '</div>';
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

function card(b){
  const routes = b.routes.map(r => '<span class="chip">' + esc(r) + '</span>').join("");
  const attempt = b.attempt ? '<span class="chip">attempt ' + esc(b.attempt) + '</span>' : "";
  const amended = b.amended ? '<span class="chip">amended</span>' : "";
  const commit = b.agent && b.agent.commit
    ? '<span class="chip">' + esc(String(b.agent.commit).slice(0,10)) + '</span>' : "";
  const lastNote = b.agent && b.agent.notes.length ? b.agent.notes[b.agent.notes.length-1].text : "";
  const notes = lastNote ? '<div class="note">' + esc(lastNote) + '</div>' : "";
  const judge = b.judgeNote ? '<div class="note"><b>judge:</b> ' + esc(b.judgeNote) + '</div>' : "";
  const claim = b.agent && b.agent.note && b.status === "reported"
    ? '<div class="note"><b>reported:</b> ' + esc(b.agent.note) + '</div>' : "";
  return '<article class="card ' + esc(b.status) + '">'
    + '<div class="top"><span class="pill">' + esc(b.status) + '</span>'
    + '<span class="tick" data-since="' + esc(b.dispatchedAt) + '" data-prefix="dispatched ">\\u2014</span></div>'
    + '<h3 class="title">' + esc(b.label) + '</h3>'
    + whoLine(b)
    + '<div class="meta"><span class="chip sev ' + esc(b.severity) + '">' + esc(b.severity) + '</span>'
    + '<span class="chip">' + esc(b.category) + '</span>' + routes + attempt + amended + commit + '</div>'
    + strip("What this session is fixing", b.shots, b.sheetRel)
    + strip("What verify-fix saw afterwards", b.recheck, null)
    + claim + notes + judge
    + '<div class="brief">' + esc(b.brief) + '</div>'
    + '</article>';
}

async function tick(){
  let d; try { d = await (await fetch("/api/status")).json(); } catch { return; }
  const s = d.status;
  document.body.classList.toggle("live", s.running);
  el("ttl").textContent = d.project ? "lookout \\u00b7 " + d.project : "lookout";
  el("phase").textContent = s.runId ? s.phase : "no run recorded yet";
  const elapsedNode = el("el");
  if (s.startedAt){
    elapsedNode.dataset.since = s.startedAt;
    if (s.endedAt && !s.running) elapsedNode.dataset.until = s.endedAt; else delete elapsedNode.dataset.until;
    elapsedNode.dataset.prefix = (s.running ? "running " : "ran for ");
  }

  const a = s.agents;
  el("stats").innerHTML =
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

  const board = s.board || [];
  el("bn").textContent = board.length ? board.length + " dispatched" : "";
  // The signature carries everything a card renders, so a card is rebuilt when
  // its session moves and left alone (thumbnails intact) when it does not.
  const sig = JSON.stringify(board.map(b => [b.id, b.status, b.attempt, b.verdict,
    b.shots.length, b.recheck.length, b.sheetRel,
    b.agent && [b.agent.name, b.agent.startedAt, b.agent.finishedAt, b.agent.notes.length]]));
  paint("board", sig, board.length
    ? board.map(card).join("")
    : '<div class="panel empty">Nothing dispatched yet. Run <code>lookout check --auto</code>.</div>');

  const finds = d.events.filter(e => e.kind === "finding");
  el("fn").textContent = finds.length ? finds.length + " open" : "";
  paint("findings", String(finds.length), finds.length ? finds.slice().reverse().map(e => {
    const x = e.data || {};
    return '<div class="f ' + esc(x.severity) + '"><span class="sev">' + esc(x.severity) + '</span> '
      + esc(x.category) + "/" + esc(x.attribute)
      + '<div>' + esc(e.message.replace(/^[^:]*:\\s*/, "")) + '</div>'
      + '<div class="faint">' + esc([x.route, x.formFactor, x.scheme].filter(Boolean).join(" \\u00b7 ")) + '</div></div>';
  }).join("") : '<div class="empty">No findings yet.</div>');

  // Everything a card already shows is on a card. This is the remainder: the
  // captures no cluster was filed against, which is usually the healthy part
  // of the app and belongs out of the way.
  const claimed = new Set();
  for (const b of board){
    for (const sh of b.shots) claimed.add(sh.path);
    for (const sh of b.recheck) claimed.add(sh.path);
  }
  const others = d.events.filter(e => e.kind === "shot" && e.data && e.data.path
    && !claimed.has(e.data.path));
  el("othersSum").textContent = others.length
    ? "Every other capture in this run (" + others.length + ")"
    : "No other captures in this run";
  el("othersWrap").style.display = others.length ? "" : "none";
  paint("others", String(others.length) + ":" + claimed.size, others.map(e => {
    const p = enc(e.data.path);
    return '<a href="/evidence/' + p + '" target="_blank" title="open the full-resolution shot">'
      + '<img loading="lazy" src="/thumb/' + p + '?w=380" alt=""/>'
      + '<div class="cap">' + esc(e.message) + '</div></a>';
  }).join(""));

  paint("log", String(d.events.length), d.events.slice(-120).reverse()
    .map(e => '<div><span class="faint">' + esc(e.at.slice(11,19)) + '</span> <span class="k">'
      + esc(e.kind) + '</span> ' + esc(e.message) + '</div>').join(""));
  ticks();
}
tick(); setInterval(tick, 1500); setInterval(ticks, 1000);
</script></body></html>`;
