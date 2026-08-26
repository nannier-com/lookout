/**
 * `lookout ui`: a local page showing what lookout is doing, while it does it.
 *
 * Everything lookout knows is already on disk in the event log and the evidence
 * directory, so this is a reader: a small static server plus a page that polls.
 * It starts nothing and judges nothing, which means it can be left open across
 * runs and can watch a run started by any agent in any terminal.
 *
 * No dependencies: node's own http server, and a page inlined below. Bound to
 * the loopback interface, because it serves screenshots of the user's app.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
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

function handle(resolved: ResolvedConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const evDir = evidenceDir(resolved);

  if (url.pathname === "/api/status") {
    const events = readEvents(resolved);
    const body = JSON.stringify({
      project: resolved.project,
      projectDir: resolved.projectDir,
      status: summarise(events),
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
        const st = statSync(p);
        const key = `${p}|${st.mtimeMs}|${st.size}|${w}`;
        const etag = `"${Buffer.from(key).toString("base64url").slice(0, 32)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304).end();
          return;
        }
        let buf = thumbCache.get(key);
        if (!buf) {
          const sharp = (await import("sharp")).default;
          buf = await sharp(p)
            .resize(w, Math.round(w * 0.8), { fit: "cover", position: "top" })
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
:root{color-scheme:light dark;--bg:#f7f7f8;--panel:#fff;--ink:#16181d;--dim:#61656e;--line:#e3e4e8;
--crit:#b4232b;--high:#c2410c;--med:#a16207;--low:#4b5563;--ok:#15803d;--accent:#4338ca}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--ink:#e9eaee;--dim:#9aa0ab;
--line:#262a33;--crit:#f87171;--high:#fb923c;--med:#fbbf24;--low:#9ca3af;--ok:#4ade80;--accent:#a5b4fc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);
padding:14px 20px;display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;z-index:5}
h1{font-size:15px;margin:0;letter-spacing:.02em}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim);margin-right:7px}
.live .dot{background:var(--ok);animation:p 1.4s infinite}@keyframes p{50%{opacity:.25}}
.muted{color:var(--dim)}main{padding:20px;max-width:1180px;margin:0 auto}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:0 0 12px}
.row{display:flex;gap:24px;flex-wrap:wrap}.stat{min-width:96px}
.stat b{display:block;font-size:22px;font-weight:650;line-height:1.2}
.f{border-left:3px solid var(--line);padding:8px 0 8px 12px;margin-bottom:10px}
.f.critical{border-color:var(--crit)}.f.high{border-color:var(--high)}
.f.medium{border-color:var(--med)}.f.low{border-color:var(--low)}
.sev{font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.critical .sev{color:var(--crit)}.high .sev{color:var(--high)}
.medium .sev{color:var(--med)}.low .sev{color:var(--low)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.shots a{display:block;text-decoration:none;color:inherit}
.shots img{width:100%;height:150px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.cap{font-size:11px;color:var(--dim);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl{border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px}
.tag{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.tag.passed{color:var(--ok);border-color:var(--ok)}.tag.blocked,.tag.regressed{color:var(--crit);border-color:var(--crit)}
.tag['still-open']{color:var(--high)}
code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);word-break:break-all}
.log{max-height:280px;overflow:auto;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{color:var(--accent)}.empty{color:var(--dim);font-style:italic}
</style></head><body>
<header><h1><span class="dot"></span><span id="ttl">lookout</span></h1>
<span class="muted" id="phase"></span><span class="muted" id="el"></span></header>
<main>
<section><h2>Run</h2><div class="row" id="stats"></div></section>
<section><h2>Dispatched work</h2><div id="clusters"></div></section>
<section><h2>Findings</h2><div id="findings"></div></section>
<section><h2>What lookout saw</h2><div class="shots" id="shots"></div></section>
<section><h2>Activity</h2><div class="log" id="log"></div></section>
</main>
<script>
const last = {};
// Re-rendering a section on every poll restarts every image request inside it,
// which on a 1.5s interval means a thumbnail never finishes loading. Only touch
// a section when its content actually changed.
function paint(id, sig, html){ if (last[id] === sig) return; last[id] = sig; el(id).innerHTML = html; }
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const el = id => document.getElementById(id);
function stat(l, v, c){ return '<div class="stat"><b'+(c?' style="color:'+c+'"':'')+'>'+esc(v)+'</b><span class="muted">'+esc(l)+'</span></div>'; }
async function tick(){
  let d; try { d = await (await fetch("/api/status")).json(); } catch { return; }
  const s = d.status;
  document.body.classList.toggle("live", s.running);
  el("ttl").textContent = d.project ? "lookout \\u00b7 " + d.project : "lookout";
  el("phase").textContent = s.runId ? s.phase : "no run recorded yet";
  el("el").textContent = s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : "";
  el("stats").innerHTML = stat("shots", s.shots)
    + stat("batches", s.batches.total ? s.batches.done + "/" + s.batches.total : "\\u2014")
    + stat("critical", s.findings.critical, "var(--crit)")
    + stat("high", s.findings.high, "var(--high)")
    + stat("medium", s.findings.medium, "var(--med)")
    + stat("low", s.findings.low, "var(--low)")
    + stat("dispatched", s.dispatched.length);

  const clusterSig = JSON.stringify([s.dispatched.map(c => c.id), s.verdicts]);
  paint("clusters", clusterSig, s.dispatched.length ? s.dispatched.map(c => {
    const v = s.verdicts.filter(x => x.cluster === c.id).pop();
    return '<div class="cl"><b>' + esc(c.label || c.id) + '</b> '
      + '<span class="tag ' + esc(v ? v.verdict : "") + '">' + esc(v ? v.verdict + " (attempt " + v.attempt + ")" : "awaiting a fix session") + '</span>'
      + '<div class="muted">' + esc(c.routes.join(" ")) + '</div>'
      + '<code>' + esc(c.brief) + '</code></div>';
  }).join("") : '<div class="empty">Nothing dispatched yet.</div>');

  const finds = d.events.filter(e => e.kind === "finding");
  paint("findings", String(finds.length), finds.length ? finds.slice().reverse().map(e => {
    const x = e.data || {};
    return '<div class="f ' + esc(x.severity) + '"><span class="sev">' + esc(x.severity) + '</span> '
      + esc(x.category) + "/" + esc(x.attribute)
      + '<div>' + esc(e.message.replace(/^[^:]*:\\s*/, "")) + '</div>'
      + '<div class="muted">' + esc([x.route, x.formFactor, x.scheme].filter(Boolean).join(" \\u00b7 ")) + '</div></div>';
  }).join("") : '<div class="empty">No findings yet.</div>');

  const shots = d.events.filter(e => e.kind === "shot" && e.data && e.data.path);
  paint("shots", String(shots.length), shots.length ? shots.map(e => {
    const p = "/evidence/" + e.data.path.split("/").map(encodeURIComponent).join("/");
    const t = "/thumb/" + e.data.path.split("/").map(encodeURIComponent).join("/") + "?w=380";
    return '<a href="' + p + '" target="_blank" title="open the full-resolution shot">'
      + '<img loading="lazy" src="' + t + '" alt=""/>'
      + '<div class="cap">' + esc(e.message) + '</div></a>';
  }).join("") : '<div class="empty">No screenshots yet.</div>');

  paint("log", String(d.events.length), d.events.slice(-120).reverse()
    .map(e => '<div><span class="muted">' + esc(e.at.slice(11,19)) + '</span> <span class="k">'
      + esc(e.kind) + '</span> ' + esc(e.message) + '</div>').join(""));
}
tick(); setInterval(tick, 1500);
</script></body></html>`;
