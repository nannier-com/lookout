/**
 * One request in, one answer out: which handler serves what.
 *
 * Everything this dispatches to lives beside it, so the router reads as a list
 * of what the page can ask for rather than as the implementation of all of it.
 * That is the whole reason it is its own file: the page grows a new question
 * every few days, and adding one should not mean opening the module that also
 * holds the thumbnailer, the child process and the board cache.
 *
 * A handler returns a `Response` rather than writing into one. The exception is
 * the live channel, which returns nothing at all: an upgraded request stops
 * being an exchange and becomes a socket the server writes to for as long as
 * the tab is open.
 */
import type { Server } from "bun";
import { evidenceDir } from "../config.js";
import { issuesDir } from "../issues/paths.js";
import { launchHandoff, toolsAvailable } from "../report/handoff.js";
import { json, readJson, text } from "./http.js";
import { serveClient } from "./assets.js";
import { serveIssueDoc } from "./document.js";
import { serveEvidence, serveThumb } from "./evidence.js";
import { openLive } from "./live.js";
import { learningNow, statusBody } from "./payload.js";
import { pickFolder, settingsView, useProject } from "./project.js";
import { startCheck } from "./run.js";
import { currentProject, session } from "./session.js";
import { saveSettings, validBaseUrl } from "./stored-settings.js";
import { servePage } from "./page.js";

export async function handle(req: Request, server: Server<undefined>): Promise<Response | undefined> {
  const resolved = currentProject();
  const url = new URL(req.url);
  const roots = { evidence: evidenceDir(resolved), issues: issuesDir(resolved) };

  // The live channel. Everything below this line answers a question and stops;
  // this one stays open and is written to whenever the run log moves, which is
  // how a finding reaches the page while `lookout check` is still going.
  if (url.pathname === "/api/live") {
    return openLive(req, server) ? undefined : text(400, "expected a websocket upgrade");
  }

  if (req.method === "POST" && (url.pathname === "/api/project" || url.pathname === "/api/pick")) {
    let dir: string | null;
    if (url.pathname === "/api/pick") {
      dir = await pickFolder();
      if (!dir) return json(200, { cancelled: true });
    } else {
      const body = await readJson(req);
      dir = typeof body.dir === "string" ? body.dir : null;
      if (!dir) return json(400, { error: "no folder given" });
    }
    return json(200, await useProject(dir));
  }

  // Configuration is its own act, not something the run does on the way past.
  // GET reports what lookout is pointed at and whether those targets answer;
  // POST changes it and remembers, so the next launch starts configured.
  if (url.pathname === "/api/settings") {
    if (req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.baseUrl === "string") {
        const cleaned = body.baseUrl.trim();
        if (cleaned && !validBaseUrl(cleaned)) {
          return json(400, { error: `not a valid URL: ${cleaned}` });
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
    return json(200, await settingsView());
  }

  if (req.method === "POST" && url.pathname === "/api/check") {
    const r = await startCheck(resolved);
    return json(r.started ? 200 : 409, {
      ...r,
      project: resolved.project,
      projectDir: resolved.projectDir,
    });
  }

  // The same body the live channel pushes. Kept as a request because the page
  // needs one before its socket is open, and because an action the reader took
  // should repaint from its own answer rather than wait for the disk to move.
  if (url.pathname === "/api/status") {
    try {
      return new Response(await statusBody(resolved), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (err) {
      // A malformed backlog must not take the page down; say so instead.
      return json(500, { error: String(err) });
    }
  }

  // Opening an issue in a coding tool. A POST, because it writes a file and
  // starts a process: lookout only ever does this because somebody clicked.
  if (url.pathname === "/api/launch" && req.method === "POST") {
    try {
      const { issue, tool } = (await readJson(req)) as { issue?: string; tool?: string };
      if (!issue) throw new Error("no issue given");
      return json(200, await launchHandoff(resolved, issue, tool ?? "claude-code"));
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  // Filing an issue away, and putting it back. The page's only write to the
  // record, and a POST for the same reason `/api/launch` is one: it changes
  // something on disk, and lookout only ever does that because somebody asked.
  if (url.pathname === "/api/archive" && req.method === "POST") {
    try {
      const { issue, archived } = (await readJson(req)) as {
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
      return json(200, { issue, archived: archived !== false, reason: outcome.reason });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  // What lookout has changed about itself: its own instructions, and its own
  // source. Its own endpoint rather than part of the status payload, because it
  // is only worth reading while that area is open.
  if (url.pathname === "/api/learning") {
    try {
      return json(200, await learningNow(resolved));
    } catch (err) {
      // An unreadable record must not take the page down, the same way a
      // malformed backlog does not.
      return json(500, { error: String(err) });
    }
  }

  if (url.pathname === "/api/tools") {
    return json(200, await toolsAvailable(resolved));
  }

  if (url.pathname.startsWith("/thumb/")) {
    return await serveThumb(req, roots, url);
  }

  if (url.pathname.startsWith("/evidence/")) {
    return serveEvidence(roots, url);
  }

  // One issue's own document. The card prints the folder for somebody at a
  // terminal; this is the same material for somebody at the page, who cannot
  // follow a file:// link out of an http:// one.
  if (url.pathname.startsWith("/issue/")) {
    return serveIssueDoc(resolved, url.pathname);
  }

  // The page's own stylesheets and script modules, which the browser asks for
  // by name after it has parsed the shell.
  if (url.pathname.startsWith("/ui/")) {
    return serveClient(url.pathname.slice("/ui/".length));
  }

  if (url.pathname === "/") {
    return servePage();
  }
  return text(404, "not found");
}
