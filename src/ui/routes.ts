/**
 * One request in, one answer out: which handler serves what.
 *
 * Everything this dispatches to lives beside it, so the router reads as a list
 * of what the page can ask for rather than as the implementation of all of it.
 * That is the whole reason it is its own file: the page grows a new question
 * every few days, and adding one should not mean opening the module that also
 * holds the thumbnailer, the child process and the board cache.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { evidenceDir } from "../config.js";
import { launchHandoff, toolsAvailable } from "../report/handoff.js";
import { json, readJson } from "./http.js";
import { serveClient } from "./assets.js";
import { serveEvidence, serveThumb } from "./evidence.js";
import { learningNow, statusBody } from "./payload.js";
import { pickFolder, settingsView, useProject } from "./project.js";
import { startCheck } from "./run.js";
import { currentProject, session } from "./session.js";
import { saveSettings, validBaseUrl } from "./stored-settings.js";
import { servePage } from "./page.js";

export function handle(req: IncomingMessage, res: ServerResponse): void {
  const resolved = currentProject();
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
          session.settings.baseUrl = cleaned ? validBaseUrl(cleaned) : null;
        }
        if (typeof body.projectDir === "string" && body.projectDir.trim()) {
          session.settings.projectDir = body.projectDir.trim();
        }
        await saveSettings(session.settings);
        // Re-resolve so the new base URL reaches the targets immediately.
        if (session.settings.projectDir) await useProject(session.settings.projectDir);
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
    void (async () => {
      try {
        const body = await statusBody(resolved);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
      } catch (err) {
        // A malformed backlog must not take the page down; say so instead.
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
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
          const { loadBacklog, saveBacklog } = await import("../verbs/backlog.js");
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

  if (url.pathname.startsWith("/thumb/")) {
    serveThumb(req, res, evDir, url);
    return;
  }

  if (url.pathname.startsWith("/evidence/")) {
    serveEvidence(res, evDir, url);
    return;
  }

  // The page's own stylesheets and script modules, which the browser asks for
  // by name after it has parsed the shell.
  if (url.pathname.startsWith("/ui/")) {
    serveClient(res, url.pathname.slice("/ui/".length));
    return;
  }

  if (url.pathname === "/") {
    servePage(res);
    return;
  }
  res.writeHead(404).end("not found");
}
