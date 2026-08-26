/**
 * `lookout ui`: the issues lookout has found, with the pixels that prove them.
 *
 * lookout finds issues and documents them. This is where that documentation is
 * read. It is built from the backlog, which outlives any run, so it shows what
 * is outstanding whether or not anything is executing; the event log is laid
 * over the top only to say what is happening this second.
 *
 * Every card owns its evidence: the screenshots the defect was filed against,
 * a contact sheet showing them together, and every path in absolute form,
 * because the point of the page is to hand an issue to somebody who then has to
 * go and open those files.
 *
 * It starts nothing, judges nothing and dispatches nothing, which means it can
 * be left open across runs and costs nothing to keep around.
 *
 * No dependencies: node's own http server, and a page inlined below. Bound to
 * the loopback interface, because it serves screenshots of the user's app.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { evidenceDir, loadConfig } from "../config.js";
import { readEvents, summarise } from "../report/events.js";
import { buildBoard, durableFindings, severityTally, tally } from "../report/board.js";
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
        // Findings come from the backlog for the same reason the board does:
        // built from `finding` events they emptied out with the log on every
        // re-capture, and the severity counts described the log rather than
        // what is actually outstanding.
        const findings = await durableFindings(resolved);
        // The severity numbers are the triage signal and now also filters, so
        // they count work that still needs doing. A critical somebody already
        // fixed must not keep inflating "critical".
        const outstanding = findings.filter(
          (f) => f.status === "open" || f.status === "blocked",
        );
        // One image with every capture on it answers "what did lookout look at"
        // better than a grid of the ones nothing was filed against, and costs
        // the page a single link instead of a section.
        const sheet = join(evDir, "contact-sheet.png");
        const body = JSON.stringify({
          project: resolved.project,
          projectDir: resolved.projectDir,
          contactSheet: existsSync(sheet) ? "contact-sheet.png" : null,
          findings,
          status: {
            ...status,
            board: board.map((b) => ({ ...b, sheetRel: evidenceRel(evDir, b.sheet) })),
            issues: tally(board),
            findings: severityTally(outstanding),
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
  console.log("  it reads the backlog, so it shows every open issue, run or no run.");
  console.log("  findings appear as they land, while `lookout check` is still going.");
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
--ver:#7c3aed;--shadow:0 1px 2px rgba(16,18,22,.06),0 4px 12px rgba(16,18,22,.05)}
@media(prefers-color-scheme:dark){:root{
--bg:#0e1014;--panel:#171a21;--sunk:#12151b;--ink:#e9eaee;--dim:#989ea9;--faint:#6d737e;--line:#252932;
--crit:#f87171;--high:#fb923c;--med:#fbbf24;--low:#9ca3af;--ok:#4ade80;--accent:#a5b4fc;
--ver:#c4b5fd;--shadow:0 1px 2px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
-webkit-font-smoothing:antialiased}

/* --- navbar: identity, run state, and the filters ---------------------- */
header{position:sticky;top:0;z-index:9;background:var(--panel);
border-bottom:1px solid var(--line);padding:10px 22px 0}
.navtop{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding-bottom:9px}
h1{font-size:15px;margin:0;letter-spacing:.01em;font-weight:660;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);
margin-right:8px;vertical-align:middle}
.live .dot{background:var(--ok);box-shadow:0 0 0 0 var(--ok);animation:pulse 1.8s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.55)}70%{box-shadow:0 0 0 7px rgba(74,222,128,0)}
100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}
.stalled .dot{background:var(--med);animation:none}
.stalled #phase,.stalled #el{color:var(--med)}
.muted{color:var(--dim)}.faint{color:var(--faint)}
.spacer{flex:1}
.sheetlink{font-size:12px;color:var(--accent);text-decoration:none;border:1px solid var(--line);
border-radius:7px;padding:3px 9px;white-space:nowrap}
.sheetlink:hover{border-color:var(--accent)}

/* The filters live in the navbar: they are how you move around the page. */
.filters{display:flex;gap:7px;flex-wrap:wrap;align-items:stretch;padding-bottom:10px}
.stat{border:1px solid transparent;border-radius:9px;padding:4px 10px;min-width:78px;
background:none;font:inherit;color:inherit;text-align:left;line-height:1.2}
.stat b{display:block;font-size:17px;font-weight:660;font-variant-numeric:tabular-nums}
.stat span{font-size:11px;color:var(--dim);white-space:nowrap}
.stat.z b{color:var(--faint)}
button.stat{cursor:pointer}
button.stat:hover{border-color:var(--line);background:var(--sunk)}
button.stat:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.stat[aria-pressed="true"]{border-color:var(--accent);background:var(--sunk)}
button.stat[disabled]{cursor:default;opacity:.5}
button.stat.clear{border-color:var(--line);color:var(--dim);min-width:0}
button.stat.clear b{font-size:15px}
button.stat.clear:hover{border-color:var(--accent);color:var(--accent)}
.sep{width:1px;background:var(--line);margin:2px 5px}

main{padding:18px 22px 60px;max-width:1600px;margin:0 auto}
section{margin-bottom:22px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);
margin:0 0 11px;font-weight:700;display:flex;align-items:baseline;gap:9px}
h2 .n{color:var(--dim);letter-spacing:0;text-transform:none;font-weight:500;font-size:12px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px 17px;
box-shadow:var(--shadow)}
.filterbar{display:flex;align-items:center;gap:10px;margin:0 0 14px;font-size:12.5px;color:var(--dim)}
.filterbar b{color:var(--ink);font-weight:600}
@keyframes flash{from{background:var(--sunk)}to{background:transparent}}
.flash{animation:flash 1.1s ease-out}

/* --- issues ------------------------------------------------------------ */
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:14px;
align-items:start}
@media(max-width:520px){.board{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--line);
border-radius:12px;padding:13px 15px 14px;box-shadow:var(--shadow);display:flex;
flex-direction:column;gap:9px}
.card.verifying{border-left-color:var(--ver)}
.card.open{border-left-color:var(--high)}
.card.still-open,.card.regressed,.card.blocked{border-left-color:var(--crit)}
.card.done{border-left-color:var(--ok);opacity:.75}
.card.archived{opacity:.65}
.top{display:flex;align-items:center;gap:9px}
.pill{font-size:10.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;
padding:3px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.verifying .pill{color:var(--ver);border-color:var(--ver)}
.open .pill{color:var(--high);border-color:var(--high)}
.still-open .pill,.regressed .pill,.blocked .pill{color:var(--crit);border-color:var(--crit)}
.done .pill{color:var(--ok);border-color:var(--ok)}
.verifying .pill::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
background:var(--ver);margin-right:6px;vertical-align:middle;animation:pulse2 1.4s infinite}
@keyframes pulse2{50%{opacity:.2}}
.tick{margin-left:auto;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);
font-variant-numeric:tabular-nums;white-space:nowrap}
.title{font-size:14.5px;font-weight:640;margin:0;line-height:1.35;word-break:break-word}
.what{font-size:12.5px;color:var(--dim)}
.meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip{font-size:11px;padding:2px 7px;border-radius:6px;background:var(--sunk);color:var(--dim);
border:1px solid var(--line);white-space:nowrap}
.chip.critical{color:var(--crit)}.chip.high{color:var(--high)}
.chip.medium{color:var(--med)}.chip.low{color:var(--low)}
.chip.sev{font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:10px}

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

/* lookout's own record of an issue. */
.feed{background:var(--sunk);border:1px solid var(--line);border-radius:8px;
max-height:150px;overflow-y:auto;scrollbar-width:thin}
.feed::-webkit-scrollbar{width:6px}
.feed::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
.step{display:flex;gap:9px;padding:5px 10px;font-size:12px;line-height:1.45;
border-bottom:1px solid var(--line)}
.step:last-child{border-bottom:0}
.step time{flex:0 0 auto;color:var(--faint);font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
font-variant-numeric:tabular-nums}
.step .t{min-width:0;color:var(--dim);word-break:break-word}
.step.found .t,.step.verify .t{font-style:italic}
.step.verdict .t{color:var(--ink);font-weight:560}
.evi h4 em{font-style:normal;color:var(--ver);font-weight:700}
.evi h4 em::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;
background:var(--ver);margin-right:4px;vertical-align:middle;animation:pulse2 1.4s infinite}
.step.now .t::after{content:"\\u2588";color:var(--ver);margin-left:3px;
animation:blink 1.1s step-end infinite}
@keyframes blink{50%{opacity:0}}

/* Absolute paths, because the point of the page is handing an issue over. */
.paths{font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);
word-break:break-all;user-select:all}
.paths div{padding:1px 0}

/* --- findings ---------------------------------------------------------- */
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
.pill.critical{color:var(--crit);border-color:var(--crit)}
.pill.high{color:var(--high);border-color:var(--high)}
.pill.medium{color:var(--med);border-color:var(--med)}
.pill.low{color:var(--low);border-color:var(--low)}
.empty{color:var(--faint);font-style:italic;font-size:13px}
</style></head><body>
<header>
  <div class="navtop">
    <h1><span class="dot"></span><span id="ttl">lookout</span></h1>
    <span class="muted" id="phase"></span>
    <span class="spacer"></span>
    <a class="sheetlink" id="sheet" href="#" target="_blank" hidden>contact sheet</a>
    <span class="faint" id="el"></span>
  </div>
  <div class="filters" id="stats"></div>
</header>
<main>
<div class="filterbar" id="filterbar" hidden></div>
<section id="issues"><h2>Issues <span class="n" id="bn"></span></h2>
  <div class="board" id="board"></div></section>
<section id="findingsSection"><h2>Findings <span class="n" id="fn"></span></h2>
  <div class="finds" id="findings"></div></section>
</main>
<script>
const STALE_MS = 10 * 60 * 1000;
const last = {};
function paint(id, sig, html){
  if (last[id] === sig) return false;
  last[id] = sig; el(id).innerHTML = html; return true;
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const el = id => document.getElementById(id);
const enc = p => String(p).split("/").map(encodeURIComponent).join("/");

// Clicking a headline number narrows the page to the work it counts. Held here
// rather than in the URL because it is a view, not a place: a reload should
// come back to everything outstanding.
let filter = null;   // {kind: "state"|"severity", value, label}

const STATES = {
  open: ["open", "still-open", "regressed", "verifying"],
  blocked: ["blocked"],
  done: ["done"],
  archived: ["archived"],
};
// Work that is finished with is kept and reachable, but it is not what the page
// opens on: unfiltered, this is a view of what still needs doing.
const SETTLED = ["done", "archived"];
const SETTLED_FINDING = ["fixed", "by-design"];

function matchesIssue(b){
  if (!filter) return !SETTLED.includes(b.status);
  if (filter.kind === "state") return STATES[filter.value].includes(b.status);
  return b.severity === filter.value && !SETTLED.includes(b.status);
}
function matchesFinding(f, shown){
  if (!filter) return !SETTLED_FINDING.includes(f.status);
  if (filter.kind === "severity") {
    return f.severity === filter.value && !SETTLED_FINDING.includes(f.status);
  }
  return shown.has(f.cluster);
}

function setFilter(kind, value, label){
  const same = filter && filter.kind === kind && filter.value === value;
  filter = same ? null : { kind, value, label };
  tick();
  if (!filter) return;
  const target = el(kind === "severity" ? "findingsSection" : "issues");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
}

function dur(ms){
  const s = Math.max(0, Math.round(ms/1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s/60);
  if (m < 60) return m + "m" + String(s%60).padStart(2,"0") + "s";
  const h = Math.floor(m/60);
  if (h < 48) return h + "h" + String(m%60).padStart(2,"0") + "m";
  return Math.floor(h/24) + "d";
}
function ticks(){
  for (const n of document.querySelectorAll("[data-since]")){
    const to = n.dataset.until ? Date.parse(n.dataset.until) : Date.now();
    n.textContent = (n.dataset.prefix || "") + dur(to - Date.parse(n.dataset.since));
  }
}

function statBody(v, l, c, zero){
  return '<b' + (c && !zero ? ' style="color:' + c + '"' : '') + '>' + esc(v) + '</b>'
    + '<span>' + esc(l) + '</span>';
}
function stat(l, v, c){
  const zero = (v === 0 || v === "0");
  return '<div class="stat' + (zero ? ' z' : '') + '">' + statBody(v, l, c, zero) + '</div>';
}
function statFilter(kind, value, l, v, c){
  const zero = (v === 0 || v === "0");
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

function tile(s, w){
  return '<a class="tile" href="/evidence/' + enc(s.path) + '" target="_blank" title="' + esc(s.absPath) + '">'
    + '<img loading="lazy" src="/thumb/' + enc(s.path) + '?w=' + w + '" alt=""/>'
    + '<span>' + esc([s.formFactor, s.scheme].filter(Boolean).join(" \\u00b7 ") || s.route) + '</span></a>';
}
function strip(label, shots, sheetRel, sheetAbs){
  const tiles = shots.map(s => tile(s, 264)).join("");
  const sheet = sheetRel
    ? '<a class="tile sheet" href="/evidence/' + enc(sheetRel) + '" target="_blank" title="' + esc(sheetAbs) + '">'
      + '<img loading="lazy" src="/thumb/' + enc(sheetRel) + '?w=264&fit=inside" alt=""/>'
      + '<span>all of it, one sheet</span></a>'
    : "";
  if (!tiles && !sheet) return "";
  return '<div class="evi"><h4>' + esc(label) + '</h4><div class="strip">' + sheet + tiles + '</div></div>';
}

// What lookout has recorded about this issue, oldest first.
function feed(b){
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
function paths(b){
  const rows = [];
  if (b.sheet) rows.push(b.sheet);
  for (const s of b.shots) rows.push(s.absPath);
  for (const s of b.recheck) rows.push(s.absPath);
  if (!rows.length) return "";
  return '<div class="evi"><h4>Evidence on disk</h4><div class="paths">'
    + rows.map(p => '<div>' + esc(p) + '</div>').join("") + '</div></div>';
}

function whatLine(b){
  if (b.status === "verifying") return '<div class="what">lookout is re-judging this now.</div>';
  const n = b.attempt ? ' after ' + esc(b.attempt) + (b.attempt === 1 ? ' attempt' : ' attempts') : '';
  if (b.status === "still-open") {
    return '<div class="what">A fix was reported, but lookout still sees the defect' + n + '.</div>';
  }
  if (b.status === "regressed") {
    return '<div class="what">A fix here introduced new defects' + n + '.</div>';
  }
  if (b.status === "blocked") {
    return '<div class="what">lookout ran out of attempts' + n + '. This one needs a person.</div>';
  }
  if (b.status === "done") return '<div class="what">lookout confirmed the defect is gone.</div>';
  if (b.status === "archived") return '<div class="what">Adjudicated as intentional.</div>';
  return '<div class="what faint">Open. Nothing has been ruled on yet.</div>';
}

function card(b){
  const routes = b.routes.map(r => '<span class="chip">' + esc(r) + '</span>').join("");
  const attempt = b.attempt ? '<span class="chip">attempt ' + esc(b.attempt) + '</span>' : "";
  const seen = b.lastSeenAt
    ? '<span class="tick" data-since="' + esc(b.lastSeenAt) + '" data-prefix="seen ">\\u2014</span>'
    : '<span class="tick faint">no evidence on disk</span>';
  const judge = b.judgeNote ? '<div class="note"><b>judge:</b> ' + esc(b.judgeNote) + '</div>' : "";
  return '<article class="card ' + esc(b.status) + '">'
    + '<div class="top"><span class="pill">' + esc(b.status) + '</span>' + seen + '</div>'
    + '<h3 class="title">' + esc(b.label) + '</h3>'
    + whatLine(b)
    + '<div class="meta"><span class="chip sev ' + esc(b.severity) + '">' + esc(b.severity) + '</span>'
    + '<span class="chip">' + esc(b.category) + '</span>' + routes + attempt + '</div>'
    + strip("What lookout saw", b.shots, b.sheetRel, b.sheet)
    + strip("What verify-fix saw afterwards", b.recheck, null, null)
    + judge + feed(b) + paths(b)
    + '</article>';
}

function ownerOf(f, board){ return board.find(b => b.id === f.cluster) || null; }

function findingCard(f, board){
  const shot = f.path
    ? '<a class="fshot" href="/evidence/' + enc(f.path) + '" target="_blank" title="' + esc(f.absPath) + '">'
      + '<img loading="lazy" src="/thumb/' + enc(f.path) + '?w=336" alt=""/>'
      + '<span>' + esc([f.formFactor, f.scheme].filter(Boolean).join(" \\u00b7 ")) + '</span></a>'
    : "";
  const owner = ownerOf(f, board);
  const chips = [f.route, f.formFactor, f.scheme].filter(Boolean)
    .map(v => '<span class="chip">' + esc(v) + '</span>').join("");
  const verified = f.verified
    ? '<span class="chip" title="a second pass was asked to refute this, and could not">verified</span>'
    : "";
  const blocked = f.status === "blocked"
    ? '<span class="chip" title="lookout ran out of attempts on this">blocked</span>' : "";
  const own = owner
    ? '<div class="what faint">Part of <b>' + esc(owner.label) + '</b> \\u00b7 ' + esc(owner.status) + '</div>'
    : "";
  const p = f.absPath ? '<div class="paths">' + esc(f.absPath) + '</div>' : "";
  return '<article class="fcard ' + esc(f.severity) + '">' + shot
    + '<div class="fbody">'
    + '<div class="top"><span class="pill ' + esc(f.severity) + '">' + esc(f.severity) + '</span></div>'
    + '<h3 class="title">' + esc(f.title) + '</h3>'
    + '<div class="meta"><span class="chip">' + esc(f.category) + "/" + esc(f.attribute) + '</span>'
    + chips + verified + blocked + '</div>'
    + (f.problem ? '<p class="problem">' + esc(f.problem) + '</p>' : "")
    + own + p
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
  const phase = !s.runId ? "no run recorded yet" : stalled ? s.phase + " \\u00b7 stalled" : s.phase;
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
        + ' title="show everything again (Escape)"><b>\\u00d7</b><span>clear</span></button>' : "");
  paint("stats", statsHtml, statsHtml);

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
  const sig = JSON.stringify([filter, issues.map(b => [b.id, b.status, b.attempt, b.verdict,
    b.shots.length, b.recheck.length, b.sheetRel, b.lastSeenAt, (b.timeline || []).length])]);
  const feedTops = {};
  for (const f of document.querySelectorAll("[data-feed]")) feedTops[f.dataset.feed] = f.scrollTop;
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
    for (const f of document.querySelectorAll("[data-feed]")) {
      const b = issues.find(x => x.id === f.dataset.feed);
      const was = feedTops[f.dataset.feed];
      f.scrollTop = (b && b.status === "verifying") || was === undefined ? f.scrollHeight : was;
    }
  }

  const allFinds = d.findings || [];
  const shown = new Set(issues.map(b => b.id));
  const finds = allFinds.filter(f => matchesFinding(f, shown));
  el("fn").textContent = allFinds.length
    ? (finds.length === allFinds.length
        ? allFinds.length + " outstanding"
        : finds.length + " of " + allFinds.length)
    : "";
  paint("findings", JSON.stringify([filter,
      finds.map(f => [f.fingerprint, f.severity, f.status]),
      allIssues.map(b => [b.id, b.status])]),
    finds.length
      ? finds.map(f => findingCard(f, allIssues)).join("")
      : '<div class="panel empty">'
        + (filter && allFinds.length ? 'No ' + esc(filter.label) + ' findings.' : 'No findings yet.')
        + '</div>');

  const sheetLink = el("sheet");
  if (d.contactSheet) {
    sheetLink.href = "/evidence/" + enc(d.contactSheet);
    sheetLink.hidden = false;
  } else sheetLink.hidden = true;

  ticks();
}

// Delegated, because the filter row is rebuilt whenever its numbers move.
document.addEventListener("click", e => {
  // The clear control is styled as a tile, so it must be taken out first: it
  // carries no kind or value, and falling into the branch below would set a
  // filter matching nothing at all.
  if (filter && e.target.closest("#clearTile")) {
    setFilter(filter.kind, filter.value, filter.label);
    return;
  }
  const tile = e.target.closest("button.stat");
  if (tile && !tile.disabled && tile.dataset.kind) {
    setFilter(tile.dataset.kind, tile.dataset.value, tile.dataset.label);
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && filter) setFilter(filter.kind, filter.value, filter.label);
});
tick(); setInterval(tick, 1500); setInterval(ticks, 1000);
</script></body></html>`;
