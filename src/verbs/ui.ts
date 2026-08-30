/**
 * `lookout ui`: the issues lookout has found, with the pixels that prove them.
 *
 * lookout finds issues and documents them. This is where that documentation is
 * read. It is built from the backlog, which outlives any run, so it shows what
 * is outstanding whether or not anything is executing; the event log is laid
 * over the top only to say what is happening this second.
 *
 * Every card owns its evidence: the screenshots the defect was filed against,
 * the screenshots that prove them, and every path in absolute form,
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
import { downReason, preflight, resolveTargets } from "../targets.js";
import {
  loadSettings,
  saveSettings,
  validBaseUrl,
  type UiSettings,
} from "./ui-settings.js";
import { readEvents, summarise } from "../report/events.js";
import { buildBoard, severityTally, tally } from "../report/board.js";
import { buildLearning, learningBadge, learningKey, type Learning } from "../report/learning.js";
import { launchHandoff, toolsAvailable } from "../report/handoff.js";
import { LEARNING_CSS, LEARNING_HTML, LEARNING_JS } from "./ui-learning.js";
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

/**
 * What lookout has changed about itself, held the way the board is held.
 *
 * Assembling it reads the skill files, the amendment history, the frozen set,
 * the machine-wide incident log and a git log of lookout's own checkout. The
 * page polls, so the answer is kept until one of those moves. Both readers
 * share the cache: the area itself serves this object, and the rail's dot is
 * one line folded out of the same one.
 */
let learningCache: { key: string; value: Learning } | null = null;

async function learningNow(resolved: ResolvedConfig): Promise<Learning> {
  const key = resolved.projectDir + "|" + learningKey(resolved);
  if (learningCache?.key === key) return learningCache.value;
  const value = await buildLearning(resolved);
  learningCache = { key, value };
  return value;
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

/** Where the page has been pointed, and where the app actually is. */
let settings: UiSettings = { projectDir: null, baseUrl: null };

/** The check in flight, if the page started one. */
let running: { child: ChildProcess; projectDir: string } | null = null;

/**
 * Why the last run this page started ended badly, if it did.
 *
 * The child used to be spawned with its output discarded and only an `error`
 * handler attached, which fires when the process cannot be LAUNCHED and never
 * when it exits non-zero. A run that started and died a second later (target
 * down, unreadable config, nothing captured) left the page idle and blank with
 * the one artifact that explained it, its stderr, thrown away.
 */
let lastFailure: { code: number | null; message: string } | null = null;

function checkIsRunning(): boolean {
  return running !== null && running.child.exitCode === null && !running.child.killed;
}

async function startCheck(project: ResolvedConfig): Promise<{ started: boolean; reason?: string }> {
  if (running && running.child.exitCode === null) {
    return { started: false, reason: "a check is already running" };
  }
  if (!project.configPath) {
    return { started: false, reason: "no .lookout/config.ts in that folder" };
  }

  // Ask whether the app is even reachable before spending a run on it. The CLI
  // path would throw `requireUp` moments from now; doing it here means the page
  // can say which target is down and how to start it, instead of showing
  // nothing while a doomed subprocess exits into a discarded pipe.
  try {
    const reason = downReason(
      await preflight(resolveTargets(project.config, undefined, undefined, project.configPath)),
    );
    if (reason) return { started: false, reason };
  } catch (e) {
    // A config that cannot even be resolved into targets is itself the answer.
    return { started: false, reason: (e as Error).message };
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
    // stderr is kept, not discarded: it carries the only explanation a failed
    // run ever produces.
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString();
  });
  child.on("error", (err) => {
    lastFailure = { code: null, message: err.message };
    running = null;
  });
  // Exit codes are contractual: 1 findings, 2 execution error, 3 blocked. Only
  // 2 and unexpected codes are failures worth surfacing; 0 and 1 are answers.
  child.on("exit", (code) => {
    if (code !== null && code > 1) {
      lastFailure = { code, message: tailLines(stderr) || `check exited ${code}` };
    }
    running = null;
  });
  lastFailure = null;
  running = { child, projectDir: project.projectDir };
  return { started: true };
}

/** Cap on retained stderr: enough to carry a LookoutError and its hint. */
const MAX_STDERR = 4000;

/** The last few non-empty lines, which is where a CLI puts its actual message. */
function tailLines(text: string, lines = 4): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-lines)
    .join("\n");
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Point lookout at a directory, reporting honestly when it has no config. */
async function useProject(dir: string): Promise<Record<string, unknown>> {
  try {
    current = await loadConfig({ cwd: dir, baseUrl: settings.baseUrl ?? undefined });
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

/**
 * What the settings panel shows: where lookout is pointed, and whether the
 * targets that implies actually answer right now.
 *
 * Probing here is what makes the panel worth opening: a wrong port is visible
 * before a run is spent on it, rather than after.
 */
async function settingsView(): Promise<Record<string, unknown>> {
  const configured = current?.configPath !== null && current?.configPath !== undefined;
  let targets: { name: string; url: string; routes: number; up: boolean; status: number | null }[] = [];
  let error: string | null = null;
  if (configured) {
    try {
      const statuses = await preflight(
        resolveTargets(current.config, undefined, undefined, current.configPath),
      );
      targets = statuses.map((t) => ({
        name: t.name,
        url: t.url,
        routes: t.routes,
        up: t.up,
        status: t.status,
      }));
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return {
    projectDir: settings.projectDir ?? current?.projectDir ?? null,
    baseUrl: settings.baseUrl,
    configPath: current?.configPath ?? null,
    project: current?.project ?? null,
    configured,
    targets,
    error,
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

  // Configuration is its own act, not something the run does on the way past.
  // GET reports what lookout is pointed at and whether those targets answer;
  // POST changes it and remembers, so the next launch starts configured.
  if (url.pathname === "/api/settings") {
    void (async () => {
      if (req.method === "POST") {
        const body = await readJson(req);
        if (typeof body.baseUrl === "string") {
          const cleaned = body.baseUrl.trim();
          if (cleaned && !validBaseUrl(cleaned)) {
            json(res, 400, { error: `not a valid URL: ${cleaned}` });
            return;
          }
          settings.baseUrl = cleaned ? validBaseUrl(cleaned) : null;
        }
        if (typeof body.projectDir === "string" && body.projectDir.trim()) {
          settings.projectDir = body.projectDir.trim();
        }
        await saveSettings(settings);
        // Re-resolve so the new base URL reaches the targets immediately.
        if (settings.projectDir) await useProject(settings.projectDir);
      }
      json(res, 200, await settingsView());
    })();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/check") {
    void (async () => {
      const r = await startCheck(resolved);
      json(res, r.started ? 200 : 409, {
        ...r,
        project: resolved.project,
        projectDir: resolved.projectDir,
      });
    })();
    return;
  }

  if (url.pathname === "/api/status") {
    // Keyed on the project too, so pointing lookout elsewhere cannot serve the
    // previous one's board.
    // The failure is part of the key: a body cached from before a run died
    // would keep serving "nothing wrong here" over the top of the reason.
    const key =
      resolved.projectDir +
      "|" +
      diskKey(resolved) +
      "|" +
      // The rail's dot rides on this payload, so a heal starting or an
      // amendment landing has to invalidate it: without this the cached body
      // would keep saying lookout is idle while it is rewriting itself.
      learningKey(resolved) +
      "|" +
      checkIsRunning() +
      "|" +
      (lastFailure ? `${lastFailure.code}:${lastFailure.message}` : "");
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
          // Why the last run this page started ended badly, if it did. Null is
          // the common case and means nothing has gone wrong, not that nothing
          // is known.
          lastFailure,
          status: {
            ...status,
            board,
            issues: tally(board),
            checkRunning: checkIsRunning(),
            findings: severityTally(outstanding),
            // One line about lookout working on lookout, so the rail can say so
            // from whichever area is open.
            learning: learningBadge(await learningNow(resolved)),
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

  // Filing an issue away, and putting it back. The page's only write to the
  // record, and a POST for the same reason `/api/launch` is one: it changes
  // something on disk, and lookout only ever does that because somebody asked.
  if (url.pathname === "/api/archive" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      void (async () => {
        try {
          const { issue, archived } = JSON.parse(body || "{}") as {
            issue?: string;
            archived?: boolean;
          };
          if (!issue) throw new Error("no issue given");
          const { loadBacklog, saveBacklog } = await import("./backlog.js");
          const { archiveIssue, unarchiveIssue } = await import("../issues/registry.js");
          const backlog = await loadBacklog(resolved);
          const outcome =
            archived === false
              ? unarchiveIssue(backlog, issue)
              : archiveIssue(backlog, issue, new Date().toISOString());
          if (!outcome.ok) throw new Error(outcome.why);
          // The save is what moves the folder: the record says which side the
          // issue belongs on and materialising it puts the folder there.
          await saveBacklog(resolved, backlog);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ issue, archived: archived !== false, reason: outcome.reason }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      })();
    });
    return;
  }

  // What lookout has changed about itself: its own instructions, and its own
  // source. Its own endpoint rather than part of the status payload, because it
  // is only worth reading while that area is open.
  if (url.pathname === "/api/learning") {
    void (async () => {
      try {
        json(res, 200, await learningNow(resolved));
      } catch (err) {
        // An unreadable record must not take the page down, the same way a
        // malformed backlog does not.
        json(res, 500, { error: String(err) });
      }
    })();
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
  // The page is where lookout gets configured now, so the server has to be able
  // to start with nothing configured. It used to refuse, which meant the one
  // screen that can fix an unconfigured project could not be opened until the
  // project was already configured.
  settings = await loadSettings();
  const explicit = str(parsed.flags.config) ?? str(parsed.flags.url);
  const baseUrl = str(parsed.flags["base-url"]) ?? settings.baseUrl ?? undefined;
  const startIn = explicit ? undefined : settings.projectDir ?? undefined;
  let resolved: ResolvedConfig;
  try {
    resolved = await loadConfig({
      configPath: str(parsed.flags.config),
      url: str(parsed.flags.url),
      baseUrl,
      ...(startIn ? { cwd: startIn } : {}),
    });
    if (resolved.configPath) settings.projectDir = resolved.projectDir;
  } catch {
    // Nothing to point at yet. Serve the page anyway and let it ask.
    resolved = {
      config: { targets: [] },
      configPath: null,
      projectDir: startIn ?? process.cwd(),
      project: "lookout",
    };
  }
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

/**
 * The whole page, script included.
 *
 * Exported so a test can parse the client script. It lives inside a template
 * literal, which means neither tsc nor eslint ever sees it: a stray escape in
 * here emits a broken string into the served JS and the entire page silently
 * stops working, with nothing failing at build time. `test/ui-page.test.ts`
 * parses it for exactly that reason.
 */
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>lookout</title>
<style>
:root{color-scheme:light dark;--rail:56px;
--bg:#f6f7f9;--panel:#fff;--sunk:#f0f1f4;--ink:#15171c;--dim:#5f636d;--faint:#8b909b;--line:#e2e4e9;
--crit:#b4232b;--high:#c2410c;--med:#a16207;--low:#4b5563;--ok:#15803d;--accent:#4338ca;
--ver:#7c3aed;--go:#177d43;--shadow:0 1px 2px rgba(16,18,22,.06),0 4px 12px rgba(16,18,22,.05)}
@media(prefers-color-scheme:dark){:root{
--bg:#0e1014;--panel:#171a21;--sunk:#12151b;--ink:#e9eaee;--dim:#989ea9;--faint:#6d737e;--line:#252932;
--crit:#f87171;--high:#fb923c;--med:#fbbf24;--low:#9ca3af;--ok:#4ade80;--accent:#a5b4fc;
--ver:#c4b5fd;--go:#22c55e;--shadow:0 1px 2px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
body{margin:0;padding-left:var(--rail);background:var(--bg);color:var(--ink);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
-webkit-font-smoothing:antialiased}

/* --- the rail: which of lookout's two subjects you are looking at ------- */
/* Two areas, so two icons rather than two words. The rail is somewhere to be
   rather than a menu to read, and each name lives in the accessible label and
   the tooltip, which is where a screen reader and a hover can both reach it. */
.rail{position:fixed;left:0;top:0;bottom:0;width:var(--rail);z-index:10;
background:var(--panel);border-right:1px solid var(--line);display:flex;
flex-direction:column;align-items:center;gap:6px;padding:12px 0}
.railb{position:relative;width:38px;height:38px;border-radius:10px;padding:0;
border:1px solid transparent;background:none;color:var(--faint);cursor:pointer;
display:flex;align-items:center;justify-content:center}
.railb svg{display:block}
.railb:hover{color:var(--ink);background:var(--sunk)}
.railb:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.railb[aria-current="page"]{color:var(--accent);background:var(--sunk);border-color:var(--line)}
/* The only thing the rail says on its own: lookout is working on itself, or
   something it wrote is waiting to be read. */
.rdot{position:absolute;top:5px;right:5px;width:7px;height:7px;border-radius:50%;
background:var(--med)}
.rdot.live{background:var(--ver);animation:pulse2 1.4s infinite}
.rdot[hidden]{display:none}
@media(max-width:520px){:root{--rail:46px}.railb{width:34px;height:34px}}

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
/* Filing an issue away. Same shape as the launch control so the row does not
   jump between cards, and deliberately not green: this is not "go", it is the
   quiet act of clearing something that is already finished. */
.filed{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:8px;
border:1px solid var(--line);background:none;color:var(--dim);cursor:pointer;
font:inherit;font-size:11.5px;line-height:1}
.filed svg{display:block}
.filed:hover{border-color:var(--dim);background:var(--sunk);color:var(--ink)}
.filed:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.filed[disabled]{opacity:.55;cursor:default}
.launched{font-size:11.5px;color:var(--dim);word-break:break-all}
.launched code{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
user-select:all}

/* The filters live in the navbar: they are how you move around the page. */
.filters{display:flex;gap:7px;flex-wrap:wrap;align-items:stretch;padding-bottom:10px}
/* An author display rule beats [hidden]{display:none}, so hiding the filters
   with the board has to be said explicitly. */
.filters[hidden]{display:none}
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
/* A path is read from its tail, which is why .where is rtl and clipped to one
   line. A message is read from its start and can be several lines, so it needs
   the opposite of all three. */
.where.notice{direction:ltr;white-space:pre-wrap;overflow:visible;text-overflow:clip;
max-width:60ch;color:var(--crit)}
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
/* Grey until there is something to run. Play means "go", so it must not look
   like "go" while pressing it could only produce an error. */
.findfix.unset{background:var(--sunk);color:var(--faint);
box-shadow:inset 0 0 0 1px var(--line)}
.findfix.unset:hover{filter:none;transform:none}
/* The cog sits to the right of play: configuring is the rarer act, so it is the
   quieter control, and it never moves once the run starts. */
.cog{width:26px;height:26px;padding:0;margin-left:8px;border-radius:50%;
border:1px solid var(--line);background:var(--panel);color:var(--dim);cursor:pointer;
display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.cog svg{display:block}
.cog:hover{color:var(--ink);border-color:var(--dim)}
.cog[aria-expanded="true"]{color:var(--ink);border-color:var(--accent)}
.settings{border-top:1px solid var(--line);padding:12px 16px;display:flex;
flex-direction:column;gap:8px;background:var(--sunk)}
/* An author display rule beats the UA stylesheet's [hidden]{display:none}, so
   the panel has to opt back out explicitly or it is never actually hidden. */
.settings[hidden]{display:none}
.srow{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dim)}
.srow>span:first-child{width:72px;flex:0 0 auto;color:var(--faint)}
.srow .val{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.srow input{flex:1 1 auto;min-width:0;padding:5px 8px;border-radius:6px;
border:1px solid var(--line);background:var(--panel);color:var(--ink);
font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.srow input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.mini{padding:5px 10px;border-radius:6px;border:1px solid var(--line);
background:var(--panel);color:var(--ink);font-size:11px;cursor:pointer;flex:0 0 auto}
.mini:hover{border-color:var(--dim)}
.shint{margin:0 0 0 82px;font-size:11px;color:var(--faint);max-width:70ch}
.targets{margin-left:82px;display:flex;flex-direction:column;gap:3px}
.tgt{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.tgt b{font-weight:600;color:var(--ink)}
.tgt .up{color:var(--ok)}
.tgt .down{color:var(--crit)}
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
/* Before and after, as pairs rather than as two lists: the comparison is the
   whole point, and a reader should not have to match a phone shot in one strip
   against a phone shot in another. */
.pairs{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}
.pairs::-webkit-scrollbar{height:6px}
.pairs::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
.pair{flex:0 0 auto;display:flex;flex-direction:column;gap:4px}
.pair .frames{display:flex;gap:6px;align-items:flex-start}
.pair .side{position:relative}
/* Bottom-left, not top-left: a thumbnail is cropped to the top of the page, so
   the top-left corner is the screen's own heading and a badge sitting there
   covers the first thing a reader looks at. */
.pair .side b{position:absolute;left:5px;bottom:5px;font-size:9px;font-weight:700;
text-transform:uppercase;letter-spacing:.06em;padding:2px 5px;border-radius:5px;
background:rgba(0,0,0,.72);color:#fff;pointer-events:none;line-height:1.5}
.pair .side.after b{background:var(--ok);color:#04170c}
.pair .lbl{font-size:10.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;
white-space:nowrap;max-width:270px}
.pair .missing{width:132px;height:106px;border:1px dashed var(--line);border-radius:7px;
display:flex;align-items:center;justify-content:center;font-size:10.5px;color:var(--faint);
text-align:center;padding:0 8px;line-height:1.35}

.note{font-size:12.5px;color:var(--dim);background:var(--sunk);border-radius:7px;padding:7px 9px;
border:1px solid var(--line)}
.note b{color:var(--ink);font-weight:600}

/* The commit a fix landed in. A link when the repository has a web home, and
   the same sentence in plain text when it does not, because the sha is worth
   reading either way. */
.commit{font-size:12px;color:var(--dim);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.commit code{font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
.commit a{color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.commit a:hover code{border-color:var(--accent)}
.commit a:hover{text-decoration:underline}
.commit .host{color:var(--faint);font-size:11px}
.commit svg{display:block;opacity:.75}

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
${LEARNING_CSS}
</style></head><body>
<nav class="rail" aria-label="Areas">
  <button type="button" class="railb" data-view="issues" aria-current="page"
    aria-label="Issues" title="Issues: what lookout found in the application">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/>
      <path d="M6.5 7.5h4M6.5 16.5h4"/></svg></button>
  <button type="button" class="railb" data-view="learning" aria-current="false"
    aria-label="What lookout has changed about itself"
    title="lookout on lookout: its own instructions, and its own source">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 3.2 12.9 8.1 17.8 10 12.9 11.9 11 16.8 9.1 11.9 4.2 10 9.1 8.1Z"/>
      <path d="M18 15.2 18.8 17.2 20.8 18 18.8 18.8 18 20.8 17.2 18.8 15.2 18 17.2 17.2Z"/></svg>
    <i class="rdot" id="railDot" hidden></i></button>
</nav>
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
    <button type="button" class="cog" id="cog" aria-label="Settings" aria-expanded="false"
      title="Settings"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></button>
  </div>
  <div class="settings" id="settings" hidden>
    <label class="srow">
      <span>Project</span>
      <span class="val" id="setProject">not set</span>
      <button type="button" class="mini" id="pickProject">Choose folder</button>
    </label>
    <label class="srow">
      <span>Base URL</span>
      <input type="text" id="setUrl" placeholder="leave empty to use the config"
        spellcheck="false" autocomplete="off">
      <button type="button" class="mini" id="saveUrl">Save</button>
    </label>
    <p class="shint">Overrides where the targets live. The config still supplies
      the routes, viewports, state recipes and sign-in hook.</p>
    <div class="targets" id="setTargets"></div>
  </div>
</header>
<main>
<div id="viewIssues">
<div class="runnote" id="runnote" hidden></div>
<div class="filterbar" id="filterbar" hidden></div>
<section id="issues"><h2>Issues <span class="n" id="bn"></span></h2>
  <div class="board" id="board"></div></section>
</div>
${LEARNING_HTML}
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

/**
 * The defect and what replaced it, one pair per view.
 *
 * Paired on route, form factor and scheme, because a comparison the reader has
 * to assemble themselves out of two strips is not a comparison. A view with
 * only one side still shows: the missing half says which side is missing rather
 * than silently dropping the frame, since "there is no after for the phone" is
 * itself worth seeing.
 */
function fixStrip(b){
  const before = b.before || [], after = b.after || [];
  if (!before.length && !after.length) return "";
  const key = s => [s.route, s.formFactor, s.scheme, s.state || ""].join("|");
  const afterBy = new Map(after.map(s => [key(s), s]));
  const seen = new Set();
  const pairs = [];
  for (const s of before) { pairs.push([s, afterBy.get(key(s)) || null]); seen.add(key(s)); }
  for (const s of after) if (!seen.has(key(s))) pairs.push([null, s]);

  const half = (s, side) => s
    ? '<a class="tile side ' + side + '" href="/evidence/' + enc(s.path) + '" target="_blank"'
      + ' title="' + esc(s.absPath) + '">'
      + '<img loading="lazy" src="/thumb/' + enc(s.path) + '?w=264" alt=""/>'
      + '<b>' + side + '</b></a>'
    : '<div class="missing">no ' + side + ' frame</div>';

  const body = pairs.map(([bf, af]) => {
    const s = bf || af;
    const label = [s.formFactor, s.scheme].filter(Boolean).join(" \u00b7 ") || s.route;
    return '<div class="pair"><div class="frames">' + half(bf, "before") + half(af, "after")
      + '</div><div class="lbl">' + esc(label) + '</div></div>';
  }).join("");
  return '<div class="evi"><h4>The fix</h4><div class="pairs">' + body + '</div></div>';
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

// The commit behind this issue, linked where there is somewhere to link to.
//
// The wording carries the difference lookout cares about: a commit it ruled on
// cleared the defect, and a commit somebody reported is still a claim. Saying
// "fixed in" about the second one would put lookout's name behind a verdict it
// has not reached.
function commitLine(b){
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
function cardAction(b){
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
let project = { configured: false, projectDir: "", checkRunning: false };

/**
 * Why the last thing you asked for did not happen.
 *
 * This exists because the reason used to be written straight into the "where"
 * element, which tick() then overwrote with the project path on its next poll.
 * Every explanation this page produced was erased within a second of appearing,
 * so picking an unusable folder looked identical to picking a fine one and
 * getting no results. Held as state instead, with tick() rendering the notice
 * when there is one and the path otherwise, so precedence is decided not raced.
 *
 * No backticks anywhere in this script: it lives inside a template literal.
 */
let notice = null;

function say(message){
  notice = message;
  paintWhere();
}

function paintWhere(){
  const where = el("where");
  const text = notice ?? project.projectDir;
  if (where.textContent !== text) where.textContent = text;
  // Double-escaped on purpose: this script lives inside a template literal, so
  // a single backslash-n would be consumed here and emit a raw newline into the
  // served JS, breaking the string it sits in.
  where.title = notice ? notice + "\\n\\n" + project.projectDir : project.projectDir;
  where.classList.toggle("notice", notice !== null);
}

/**
 * Play, in one of three states.
 *
 * Grey until something is configured, because a green "go" that can only
 * produce an error is a lie told by a colour. Green when it would really run.
 * A turning ring while it is running.
 */
function paintPlay(){
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
let config = { configured: false, projectDir: null, baseUrl: null, targets: [] };

function paintSettings(){
  el("setProject").textContent = config.projectDir || "not set";
  el("setProject").title = config.projectDir || "";
  const input = el("setUrl");
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
    box.innerHTML = config.targets.map(t =>
      '<div class="tgt"><b>' + esc(t.name) + "</b> " + esc(t.url) +
      "  (" + t.routes + " route" + (t.routes === 1 ? "" : "s") + ")  " +
      '<span class="' + (t.up ? "up" : "down") + '">' +
      (t.up ? "reachable" : "not responding" + (t.status ? " (HTTP " + t.status + ")" : "")) +
      "</span></div>").join("");
  }
  paintPlay();
}

async function loadConfigState(){
  try { config = await (await fetch("/api/settings")).json(); } catch { return; }
  project.configured = !!config.configured;
  paintSettings();
}

async function saveConfigState(body){
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) { say(data.error); return; }
  config = data;
  project.configured = !!config.configured;
  say(null);
  last.board = null;
  paintSettings();
  await tick();
}

function toggleSettings(){
  const panel = el("settings");
  const open = panel.hidden;
  panel.hidden = !open;
  el("cog").setAttribute("aria-expanded", String(open));
  if (open) loadConfigState();
}

async function findAndFix(){
  const btn = el("findfix");
  // Configuring is the cog's job. Play only ever runs, and says so plainly when
  // there is nothing to run.
  if (!project.configured) {
    say("no project configured yet: open settings and choose one");
    if (el("settings").hidden) toggleSettings();
    return;
  }
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/check", { method: "POST" })).json();
    // A refusal names the target that is down and how to start it, so it stays
    // up until something replaces it.
    say(r.started ? null : (r.reason || "could not start"));
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
    b.shots.length, (b.before || []).length, (b.after || []).length,
    b.lastSeenAt, (b.timeline || []).length, b.fix && b.fix.commit,
    b.archived && b.archived.reason,
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

function setView(next){
  if (view === next) return;
  view = next;
  el("viewIssues").hidden = view !== "issues";
  el("learning").hidden = view !== "learning";
  // The headline numbers are the board's filters. They go with it.
  el("stats").hidden = view !== "issues";
  for (const b of document.querySelectorAll("[data-view]")) {
    b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false");
  }
  if (view === "learning") loadLearning();
}

// The rail's dot: violet and pulsing while lookout is changing itself, amber
// while something it wrote is waiting for somebody to read it, gone otherwise.
function paintRail(b){
  const dot = el("railDot");
  const running = !!(b && b.running);
  const waiting = !!(b && b.proposed);
  dot.hidden = !running && !waiting;
  dot.className = running ? "rdot live" : "rdot";
  dot.title = running
    ? "lookout is working on itself right now"
    : waiting ? "an amendment lookout wrote is waiting to be read" : "";
}
${LEARNING_JS}
// Delegated, because the filter row is rebuilt whenever its numbers move.
document.addEventListener("click", e => {
  // The clear control is styled as a tile, so it must be taken out first: it
  // carries no kind or value, and falling into the branch below would set a
  // filter matching nothing at all.
  if (filter && e.target.closest("#clearTile")) {
    setFilter(filter.kind, filter.value, filter.label);
    return;
  }
  const area = e.target.closest("[data-view]");
  if (area) { setView(area.dataset.view); return; }
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
  if (e.target.closest("#cog")) { toggleSettings(); return; }
  if (e.target.closest("#pickProject")) {
    (async () => {
      const picked = await (await fetch("/api/pick", { method: "POST" })).json();
      if (picked.cancelled) return;
      if (picked.error) { say(picked.error); return; }
      if (!picked.configured) { say("no .lookout/config.ts in " + picked.projectDir); return; }
      await saveConfigState({ projectDir: picked.projectDir });
    })();
    return;
  }
  if (e.target.closest("#saveUrl")) {
    saveConfigState({ baseUrl: el("setUrl").value });
    return;
  }
  const go = e.target.closest("[data-launch]");
  if (go) { launch(go.dataset.launch, go); return; }
  const file = e.target.closest("[data-archive]");
  if (file) { archive(file.dataset.archive, file, !file.dataset.restore); return; }
  const tile = e.target.closest("button.stat");
  if (tile && !tile.disabled && tile.dataset.kind) {
    setFilter(tile.dataset.kind, tile.dataset.value, tile.dataset.label);
  }
});

async function archive(issue, btn, archived){
  const out = document.querySelector('[data-launched="' + CSS.escape(issue) + '"]');
  btn.disabled = true;
  try {
    const r = await fetch("/api/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issue, archived: archived }),
    });
    const j = await r.json();
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
// Settings first: the saved project decides whether Play is even live, so
// resolving it before the first poll avoids a green button flashing grey.
loadConfigState().then(loadTools).then(tick);
// Enter in the URL box saves, which is what anyone typing a URL expects.
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target && e.target.id === "setUrl") {
    e.preventDefault();
    saveConfigState({ baseUrl: e.target.value });
  }
});
setInterval(tick, 1500); setInterval(ticks, 1000);
</script></body></html>`;
