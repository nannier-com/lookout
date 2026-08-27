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
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { evidenceDir, loadConfig } from "../config.js";
import { readEvents, summarise } from "../report/events.js";
import { buildBoard, severityTally, tally } from "../report/board.js";
import { launchHandoff, toolsAvailable } from "../report/handoff.js";
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
    join(lookoutRoot(resolved), "issues"),
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

/** Read a JSON request body, capped so a stray POST cannot fill memory. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 8192) req.destroy();
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(body || "{}") as Record<string, unknown>);
      } catch {
        ok({});
      }
    });
  });
}

/**
 * Ask the operating system for a directory.
 *
 * A browser cannot hand back a real filesystem path, so the server asks
 * instead. lookout is already a local process the user started, so putting a
 * native picker in front of them is no more privileged than the terminal they
 * launched it from.
 */
async function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose the repository lookout should check")',
    ]);
    const dir = stdout.trim().replace(/\/$/, "");
    return dir || null;
  } catch {
    // The user cancelled, which is not an error.
    return null;
  }
}

/**
 * The project being served. Mutable, because the page can point lookout at a
 * different repository: `lookout ui` is then a viewer you leave open rather
 * than one bound for life to the directory it was launched in.
 */
let current: ResolvedConfig;

/** The check in flight, if the page started one. */
let running: { child: ChildProcess; projectDir: string } | null = null;

function checkIsRunning(): boolean {
  return running !== null && running.child.exitCode === null && !running.child.killed;
}

function startCheck(project: ResolvedConfig): { started: boolean; reason?: string } {
  if (running && running.child.exitCode === null) {
    return { started: false, reason: "a check is already running" };
  }
  if (!project.configPath) {
    return { started: false, reason: "no .lookout/config.ts in that folder" };
  }
  // lookout runs itself: this verb is lookout doing its own job, which is
  // finding issues and writing them down. It narrates to the event log as it
  // goes, and the page is already tailing that.
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  // --first: one run, stopping at the first issue. The loop this button serves
  // is find one, fix one, verify it, so judging on for another eight minutes to
  // hand back twenty-six more answers a question nobody has asked yet.
  const child = spawn(process.execPath, [cli, "check", "--quiet", "--first"], {
    cwd: project.projectDir,
    stdio: "ignore",
    detached: false,
  });
  child.on("error", () => {
    running = null;
  });
  running = { child, projectDir: project.projectDir };
  return { started: true };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Point lookout at a directory, reporting honestly when it has no config. */
async function useProject(dir: string): Promise<Record<string, unknown>> {
  try {
    current = await loadConfig({ cwd: dir });
  } catch {
    // No config found up the tree: say so rather than serving an empty board
    // that looks like a project with nothing wrong with it.
    return { projectDir: dir, configured: false, error: "no .lookout/config.ts found there" };
  }
  boardCache = null;
  return {
    project: current.project,
    projectDir: current.projectDir,
    configured: current.configPath !== null,
  };
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const resolved = current;
  const url = new URL(req.url ?? "/", "http://localhost");
  const evDir = evidenceDir(resolved);

  if (req.method === "POST" && (url.pathname === "/api/project" || url.pathname === "/api/pick")) {
    void (async () => {
      let dir: string | null;
      if (url.pathname === "/api/pick") {
        dir = await pickFolder();
        if (!dir) {
          json(res, 200, { cancelled: true });
          return;
        }
      } else {
        const body = await readJson(req);
        dir = typeof body.dir === "string" ? body.dir : null;
        if (!dir) {
          json(res, 400, { error: "no folder given" });
          return;
        }
      }
      json(res, 200, await useProject(dir));
    })();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/check") {
    const r = startCheck(resolved);
    json(res, r.started ? 200 : 409, {
      ...r,
      project: resolved.project,
      projectDir: resolved.projectDir,
    });
    return;
  }

  if (url.pathname === "/api/status") {
    // Keyed on the project too, so pointing lookout elsewhere cannot serve the
    // previous one's board.
    const key = resolved.projectDir + "|" + diskKey(resolved) + "|" + checkIsRunning();
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
        // Severity counts issues, not findings: an issue is the thing you act
        // on, and counting its findings separately made "5 critical" mean
        // something different from the five cards under it.
        const outstanding = board.filter(
          (b) => b.status !== "done" && b.status !== "archived",
        );
        const body = JSON.stringify({
          project: resolved.project,
          projectDir: resolved.projectDir,
          configured: resolved.configPath !== null,
          status: {
            ...status,
            board,
            issues: tally(board),
            checkRunning: checkIsRunning(),
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

  // Opening an issue in a coding tool. A POST, because it writes a file and
  // starts a process: lookout only ever does this because somebody clicked.
  if (url.pathname === "/api/launch" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      void (async () => {
        try {
          const { issue, tool } = JSON.parse(body || "{}") as { issue?: string; tool?: string };
          if (!issue) throw new Error("no issue given");
          const result = await launchHandoff(resolved, issue, tool ?? "claude-code");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      })();
    });
    return;
  }

  if (url.pathname === "/api/tools") {
    void (async () => {
      const tools = await toolsAvailable(resolved);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(tools));
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
  current = resolved;
  const server = createServer((req, res) => {
    try {
      handle(req, res);
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
--ver:#7c3aed;--go:#177d43;--shadow:0 1px 2px rgba(16,18,22,.06),0 4px 12px rgba(16,18,22,.05)}
@media(prefers-color-scheme:dark){:root{
--bg:#0e1014;--panel:#171a21;--sunk:#12151b;--ink:#e9eaee;--dim:#989ea9;--faint:#6d737e;--line:#252932;
--crit:#f87171;--high:#fb923c;--med:#fbbf24;--low:#9ca3af;--ok:#4ade80;--accent:#a5b4fc;
--ver:#c4b5fd;--go:#22c55e;--shadow:0 1px 2px rgba(0,0,0,.4)}}
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
/* Which tool a launch opens. Kept in the navbar because it applies to every
   card, and remembered because nobody wants to re-pick it every visit. */
.toggle{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.toggle button{font:inherit;padding:4px 10px;border:0;cursor:pointer;background:none;
color:var(--dim);display:flex;align-items:center;line-height:0}
.toggle button svg{display:block}
.toggle button+button{border-left:1px solid var(--line)}
.toggle button:hover{background:var(--sunk);color:var(--ink)}
.toggle button[aria-pressed="true"]{background:var(--sunk);color:var(--ink);
box-shadow:inset 0 -2px 0 var(--accent)}
.toggle button[data-missing="1"]{opacity:.45}
/* The tool's own mark, with a play beside it: the card shows what it opens in
   rather than spelling the name out on every issue. */
.launch{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:8px;
border:1px solid var(--line);background:none;color:var(--dim);cursor:pointer;line-height:0}
.launch svg{display:block}
.launch .go{color:var(--go)}
.launch:hover{border-color:var(--go);background:var(--sunk);color:var(--ink)}
.launch:focus-visible{outline:2px solid var(--go);outline-offset:2px}
.launch[disabled]{opacity:.55;cursor:default}
.launch.busy .go{animation:pulse2 1s infinite}
.launched{font-size:11.5px;color:var(--dim);word-break:break-all}
.launched code{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
user-select:all}

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
.navbottom{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.filters{padding-bottom:0}
.navbottom{padding-bottom:10px}
.where{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);
max-width:38ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;
text-align:left}
/* One green play button: the whole control means "go", so it is a shape rather
   than a sentence. Its name lives in aria-label and the tooltip. */
.findfix{width:32px;height:32px;padding:0;border-radius:50%;border:0;cursor:pointer;
background:var(--go);color:#fff;display:flex;align-items:center;justify-content:center;
flex:0 0 auto;transition:transform .12s ease,filter .12s ease}
.findfix svg{display:block;margin-left:1px}
.findfix:hover{filter:brightness(1.12);transform:scale(1.06)}
.findfix:active{transform:scale(.96)}
.findfix:focus-visible{outline:2px solid var(--go);outline-offset:3px}
.findfix[disabled]{cursor:default;transform:none;filter:none}
/* Running: the triangle gives way to a ring turning around it. */
.findfix.busy{background:none;color:var(--go);box-shadow:inset 0 0 0 2px var(--line)}
.findfix.busy svg{display:none}
.findfix.busy::after{content:"";width:16px;height:16px;border-radius:50%;
border:2px solid transparent;border-top-color:var(--go);border-right-color:var(--go);
animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

main{padding:18px 22px 60px;max-width:1600px;margin:0 auto}
section{margin-bottom:22px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);
margin:0 0 11px;font-weight:700;display:flex;align-items:baseline;gap:9px}
h2 .n{color:var(--dim);letter-spacing:0;text-transform:none;font-weight:500;font-size:12px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px 17px;
box-shadow:var(--shadow)}
.runnote{font-size:12.5px;color:var(--med);border:1px solid var(--line);border-left:3px solid var(--med);
border-radius:8px;padding:8px 12px;margin:0 0 14px;background:var(--panel)}
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
.card.still-open,.card.blocked{border-left-color:var(--crit)}
.card.done{border-left-color:var(--ok);opacity:.75}
.card.archived{opacity:.65}
.top{display:flex;align-items:center;gap:9px}
.pill{font-size:10.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;
padding:3px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.verifying .pill{color:var(--ver);border-color:var(--ver)}
.open .pill{color:var(--high);border-color:var(--high)}
.still-open .pill,.blocked .pill{color:var(--crit);border-color:var(--crit)}
.done .pill{color:var(--ok);border-color:var(--ok)}
.verifying .pill::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
background:var(--ver);margin-right:6px;vertical-align:middle;animation:pulse2 1.4s infinite}
@keyframes pulse2{50%{opacity:.2}}
.issueid{font:11.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);
background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:3px 7px;
font-variant-numeric:tabular-nums;letter-spacing:.04em}
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

/* --- acceptance criteria -------------------------------------------------
   Deliberately NOT <input type="checkbox">. These are lookout's verdicts, and
   a form control invites a viewer to change one and reads to assistive tech as
   something they can. There is no endpoint behind them either: the server has
   no route that writes issue state. */
.accept{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.crit{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.45}
.box{flex:0 0 auto;width:14px;height:14px;margin-top:1px;border-radius:4px;
border:1.5px solid var(--line);display:flex;align-items:center;justify-content:center;
font:9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);background:var(--sunk)}
.crit.met .box{border-color:var(--ok);color:var(--ok)}
.crit.unmet .box{border-color:var(--crit);color:var(--crit)}
.crit.met .ct{color:var(--dim)}
.crit.unmet .ct{color:var(--ink)}
.crit.pending .ct{color:var(--dim)}
.crit.notverifiable .ct{color:var(--faint)}
.ct{min-width:0;word-break:break-word}
.cnote{display:block;font-size:11.5px;color:var(--faint);margin-top:2px}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* --- a defect inside an issue ------------------------------------------ */
.defect{border-left:2px solid var(--line);padding:2px 0 2px 10px;margin-bottom:9px}
.defect:last-child{margin-bottom:0}
.defect.critical{border-left-color:var(--crit)}.defect.high{border-left-color:var(--high)}
.defect.medium{border-left-color:var(--med)}.defect.low{border-left-color:var(--low)}
.dtitle{font-size:13px;font-weight:600;line-height:1.4}
.dattr{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint)}
.problem{margin:4px 0 0;font-size:12.5px;line-height:1.5;color:var(--dim)}
.evi h4 .n{font-weight:500;letter-spacing:0;text-transform:none;color:var(--dim)}
.empty{color:var(--faint);font-style:italic;font-size:13px}
</style></head><body>
<header>
  <div class="navtop">
    <h1><span class="dot"></span><span id="ttl">lookout</span></h1>
    <span class="muted" id="phase"></span>
    <span class="spacer"></span>
    <span class="faint" id="el"></span>
    <div class="toggle" id="toolToggle" role="group" aria-label="open issues in"></div>
  </div>
  <div class="navbottom">
    <div class="filters" id="stats"></div>
    <span class="spacer"></span>
    <span class="where" id="where"></span>
    <button type="button" class="findfix" id="findfix" aria-label="Find and fix"></button>
  </div>
</header>
<main>
<div class="runnote" id="runnote" hidden></div>
<div class="filterbar" id="filterbar" hidden></div>
<section id="issues"><h2>Issues <span class="n" id="bn"></span></h2>
  <div class="board" id="board"></div></section>
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

// Which coding tool a launch opens. Remembered per browser, because it is a
// preference about the reader, not about the project.
let tools = [];
let tool = null;
try { tool = localStorage.getItem("lookout.tool"); } catch { tool = null; }
function toolLabel(){
  const t = tools.find(x => x.key === tool);
  return t ? t.label : "your editor";
}
function toolMark(){
  const t = tools.find(x => x.key === tool);
  return t ? t.mark : "";
}
function paintToggle(){
  const html = tools.map(t =>
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

const STATES = {
  open: ["open", "still-open", "regressed", "verifying"],
  blocked: ["blocked"],
  done: ["done"],
  archived: ["archived"],
};
// Work that is finished with is kept and reachable, but it is not what the page
// opens on: unfiltered, this is a view of what still needs doing.
const SETTLED = ["done", "archived"];

function matchesIssue(b){
  if (!filter) return !SETTLED.includes(b.status);
  if (filter.kind === "state") return STATES[filter.value].includes(b.status);
  return b.severity === filter.value && !SETTLED.includes(b.status);
}


function setFilter(kind, value, label){
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
function strip(label, shots){
  const tiles = shots.map(s => tile(s, 264)).join("");
  if (!tiles) return "";
  return '<div class="evi"><h4>' + esc(label) + '</h4><div class="strip">' + tiles + '</div></div>';
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
  // The folder first: it holds the issue's document, its record, its
  // screenshots and its attempt history, which is the whole point of numbering
  // issues. The evidence-store paths follow for anyone who wants the originals.
  if (b.dir) rows.push(b.dir);
  for (const s of b.shots) rows.push(s.absPath);
  for (const s of b.recheck) rows.push(s.absPath);
  if (!rows.length) return "";
  return '<div class="evi"><h4>On disk</h4><div class="paths">'
    + rows.map(p => '<div>' + esc(p) + '</div>').join("") + '</div></div>';
}

// The judge's own words for every defect grouped under this root cause. A
// summary of them would be lookout paraphrasing its own evidence.
function defects(b){
  const list = b.defects || [];
  if (!list.length) return "";
  const rows = list.map(d =>
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
function acceptance(b){
  const list = b.acceptance || [];
  if (!list.length) return "";
  const state = v => v === "met" ? "met" : v === "unmet" ? "unmet"
    : v === "not-verifiable" ? "notverifiable" : "pending";
  const mark = v => v === "met" ? "\u2713" : v === "unmet" ? "\u2717"
    : v === "not-verifiable" ? "\u2013" : "";
  const said = v => v === "met" ? "Met." : v === "unmet" ? "Not met."
    : v === "not-verifiable" ? "Not verifiable from the evidence." : "Not checked yet.";
  const met = list.filter(c => c.verdict === "met").length;
  const rows = list.map(c =>
    '<li class="crit ' + state(c.verdict) + '">'
    + '<span class="box" aria-hidden="true">' + mark(c.verdict) + '</span>'
    + '<span class="ct"><span class="sr">' + said(c.verdict) + ' </span>' + esc(c.text)
    + (c.note && c.verdict !== "met" ? '<span class="cnote">' + esc(c.note) + '</span>' : '')
    + '</span></li>').join("");
  return '<div class="evi"><h4>Acceptance <span class="n">' + met + ' of ' + list.length
    + ' met</span></h4><ul class="accept" role="list">' + rows + '</ul></div>';
}

function whatLine(b){
  if (b.status === "verifying") return '<div class="what">lookout is re-judging this now.</div>';
  const n = b.attempt ? ' after ' + esc(b.attempt) + (b.attempt === 1 ? ' attempt' : ' attempts') : '';
  if (b.status === "still-open") {
    return '<div class="what">A fix was reported, but lookout still sees the defect' + n + '.</div>';
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
    + '<div class="top"><span class="pill">' + esc(b.status) + '</span>'
    + '<span class="issueid" title="issue id: verify-fix --issue ' + esc(b.id) + '">'
    + esc(b.id) + '</span>' + seen + '</div>'
    + '<div class="meta"><button type="button" class="launch" data-launch="' + esc(b.id) + '"'
    + ' aria-label="Open in ' + esc(toolLabel()) + '"'
    + ' title="Open this issue in ' + esc(toolLabel()) + '">'
    + toolMark()
    + '<svg class="go" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">'
    + '<path fill="currentColor" d="M8 5.2 19 12 8 18.8Z"/></svg>'
    + '</button>'
    + '<span class="launched" data-launched="' + esc(b.id) + '"></span></div>'
    + '<h3 class="title">' + esc(b.label) + '</h3>'
    + whatLine(b)
    + '<div class="meta"><span class="chip sev ' + esc(b.severity) + '">' + esc(b.severity) + '</span>'
    + '<span class="chip">' + esc(b.category) + '</span>' + routes + attempt + '</div>'
    + defects(b)
    + acceptance(b)
    + strip("Where lookout saw it", b.shots)
    + strip("What verify-fix saw afterwards", b.recheck)
    + judge + feed(b) + paths(b)
    + '</article>';
}

// Where lookout is pointed, and whether it can run there at all.
let project = { configured: false, projectDir: "", checkRunning: false };

async function findAndFix(){
  const btn = el("findfix");
  btn.disabled = true;
  try {
    // No config in the current folder means there is nothing to check. Ask for
    // a repository first rather than starting a run that cannot work.
    if (!project.configured) {
      const picked = await (await fetch("/api/pick", { method: "POST" })).json();
      if (picked.cancelled) return;
      if (picked.error) { el("where").textContent = picked.error; return; }
      if (!picked.configured) {
        el("where").textContent = "no .lookout/config.ts in " + picked.projectDir;
        return;
      }
      project = Object.assign(project, picked);
      last.board = null;
      await tick();
    }
    const r = await (await fetch("/api/check", { method: "POST" })).json();
    if (!r.started) el("where").textContent = r.reason || "could not start";
    await tick();
  } finally {
    btn.disabled = false;
  }
}

async function loadTools(){
  try {
    tools = await (await fetch("/api/tools")).json();
  } catch { tools = []; }
  if (!tools.some(t => t.key === tool)) tool = tools.length ? tools[0].key : null;
  paintToggle();
}

async function tick(){
  let d; try { d = await (await fetch("/api/status")).json(); } catch { return; }
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

  project = {
    configured: !!d.configured,
    projectDir: d.projectDir || "",
    checkRunning: !!s.checkRunning,
  };
  const btn = el("findfix");
  btn.classList.toggle("busy", project.checkRunning);
  if (!btn.querySelector("svg")) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">'
      + '<path fill="currentColor" d="M8 5.2 19 12 8 18.8Z"/></svg>';
  }
  // The name lives in the accessible label and the tooltip: the control is a
  // shape, because the whole of it means "go".
  const name = project.checkRunning
    ? "looking for an issue"
    : project.configured ? "Find and fix" : "Choose a repo";
  btn.setAttribute("aria-label", name);
  btn.title = project.checkRunning
    ? "lookout is checking " + project.projectDir
    : project.configured
      ? "Find and fix: one check of " + project.projectDir + ", stopping at the first issue"
      : "lookout has no config here; pick the repository to check";
  const where = el("where");
  if (where.textContent !== project.projectDir && !project.checkRunning) {
    where.textContent = project.projectDir;
    where.title = project.projectDir;
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

  // A run stops at the first route with issues and files all of them, so the
  // page says how far it got: "3 issues" means three on one route, not three
  // across an application it has mostly not looked at.
  const walked = (d.events || [])
    .filter(e => e.kind === "note" && e.data && typeof e.data.checked === "number")
    .pop();
  const note = el("runnote");
  if (walked && walked.data.found) {
    note.hidden = false;
    note.textContent = "Stopped at " + walked.data.route + " after looking at "
      + walked.data.checked + " of " + walked.data.of
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
  const sig = JSON.stringify([filter, issues.map(b => [b.id, b.status, b.attempt, b.verdict,
    b.shots.length, b.recheck.length, b.lastSeenAt, (b.timeline || []).length,
    (b.acceptance || []).map(c => c.id + c.verdict).join()])]);
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
  const swap = e.target.closest("[data-tool]");
  if (swap) {
    tool = swap.dataset.tool;
    try { localStorage.setItem("lookout.tool", tool); } catch { /* private window */ }
    paintToggle();
    // The launch buttons name the tool, so they have to be redrawn with it.
    last.board = null;
    tick();
    return;
  }
  if (e.target.closest("#findfix")) { findAndFix(); return; }
  const go = e.target.closest("[data-launch]");
  if (go) { launch(go.dataset.launch, go); return; }
  const tile = e.target.closest("button.stat");
  if (tile && !tile.disabled && tile.dataset.kind) {
    setFilter(tile.dataset.kind, tile.dataset.value, tile.dataset.label);
  }
});

async function launch(issue, btn){
  const out = document.querySelector('[data-launched="' + CSS.escape(issue) + '"]');
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
    const j = await r.json();
    if (j.error) out.textContent = j.error;
    else if (j.launched) out.textContent = "opened in " + j.toolLabel;
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
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && filter) setFilter(filter.kind, filter.value, filter.label);
});
// Tools first: the launch buttons are labelled with the chosen one, and a board
// painted before the list arrives says "open in your editor".
loadTools().then(tick);
setInterval(tick, 1500); setInterval(ticks, 1000);
</script></body></html>`;
