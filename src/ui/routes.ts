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
import { toolsAvailable } from "../report/handoff.js";
import { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";
import { json, readJson, sameOrigin, text } from "./http.js";
import { serveClient } from "./assets.js";
import { serveIssueDoc } from "./document.js";
import { serveEvidence, serveThumb } from "./evidence.js";
import { openLive, pushNarration, pushNow } from "./live.js";
import { readNarration } from "../report/narration.js";
import { boardNow, learningNow, statusBody } from "./payload.js";
import { clearNarration, resetProject } from "./reset.js";
import { pumpQueue, queueableReason } from "./queue-pump.js";
import { queuedTools, saveQueue } from "./queue.js";
import { applyBaseUrl, pickFolder, settingsView, switchProject } from "./project.js";
import { startCheck, startRuling, stopCheck } from "./run.js";
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
    // Refused before the upgrade, because after it the server has already
    // spoken. A handshake needs no preflight and ignores the same-origin
    // policy, so this is the only thing standing between a page the reader
    // happened to visit and their board.
    if (!sameOrigin(req)) return text(403, "that origin did not come from this server");
    return openLive(req, server) ? undefined : text(400, "expected a websocket upgrade");
  }

  // Pointing lookout at another project. Two doors to one act: the native
  // picker, which the server opens because a browser cannot hand back a real
  // filesystem path, and a path typed into the panel. Both re-resolve
  // everything and both are remembered, so the choice survives a restart.
  if (req.method === "POST" && (url.pathname === "/api/project" || url.pathname === "/api/pick")) {
    let dir: string | null;
    if (url.pathname === "/api/pick") {
      dir = await pickFolder();
      // Cancelling a folder chooser is an answer, not a failure.
      if (!dir) return json(200, { cancelled: true });
    } else {
      const body = await readJson(req);
      dir = typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : null;
      if (!dir) return json(400, { error: "no folder given" });
    }
    const failed = await switchProject(dir);
    const view = await settingsView();
    return json(failed ? 400 : 200, failed ? { ...view, error: failed } : view);
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
      // Consent to click this project's calls to action, stored against the
      // directory it was given for, which is the project this server serves.
      if (typeof body.navigation === "boolean") {
        session.settings.navigationFor = body.navigation ? resolved.projectDir : null;
      }
      // A server that has no config has nowhere to keep settings and no
      // targets to apply them to: say so rather than writing a `.lookout/`
      // into whatever directory it was started in.
      if (!resolved.configPath) {
        return json(409, { error: "no lookout.config.ts here; nothing to remember settings for" });
      }
      await saveSettings(resolved.projectDir, session.settings);
      // Re-resolve so the new base URL reaches the targets immediately.
      await applyBaseUrl();
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

  // Taking the run back. A POST for the same reason starting one is: it is an
  // act with consequences outside this process, and lookout only ever does it
  // because somebody asked. 409 when there is nothing to stop, so a page that
  // has fallen behind is told the run has already ended rather than shown a
  // success for a signal that reached nothing.
  if (req.method === "POST" && url.pathname === "/api/stop") {
    const r = stopCheck();
    return json(r.stopped ? 200 : 409, r);
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

  // The same body the live channel pushes down a narration frame, for the same
  // reason the status route exists: a page needs one before its socket is open,
  // and a browser that never opens one still has to show a run working.
  if (url.pathname === "/api/narration") {
    return json(200, { reset: true, lines: readNarration(resolved) });
  }

  // Emptying the judge's rail. A POST because it truncates a file, and because
  // the rail is not a DOM buffer: the transcript is a file with a server-side
  // cursor over it, and the route above hands its tail to every page that
  // connects. A button that only cleared the column would refill it on the
  // next reload, which is the one outcome that would make the button a lie.
  if (req.method === "POST" && url.pathname === "/api/narration/clear") {
    await clearNarration(resolved);
    // Every open tab, not only the one that pressed. The cursor is armed with a
    // reset now, and this is what carries it.
    pushNarration();
    return json(200, { cleared: true });
  }

  // Throwing the project's record away: the heaviest thing the page can ask
  // for. 409 when it is refused, matching stop above, so a page that pressed
  // during a run is told why rather than shown a success that deleted nothing.
  //
  // It reports what it removed because the page cannot read the directory
  // itself, and "it is gone" is worth more than "ok" for an act with no undo.
  if (req.method === "POST" && url.pathname === "/api/reset") {
    const outcome = await resetProject(resolved);
    if (!outcome.ok) return json(409, outcome);
    // Forced: the push's own change detection watches the disk, and half of
    // what this reset moved was memory this process holds.
    await pushNow(true);
    pushNarration();
    return json(200, outcome);
  }

  // Asking for an issue to be fixed. A POST, because it writes a file and puts
  // something in a line that will start a process: lookout only ever does this
  // because somebody clicked.
  //
  // It queues rather than launching. Pressing play on five cards used to open
  // five Terminal windows into one working tree; what the press means is "this
  // one next", and the pump is what turns a list of those into one handoff at
  // a time.
  if (url.pathname === "/api/queue" && req.method === "POST") {
    try {
      const body = (await readJson(req)) as { issue?: string; tool?: string; tools?: unknown };
      const issue = body.issue;
      if (!issue) throw new Error("no issue given");
      const tools = queuedTools(body);
      const board = await boardNow(resolved);
      const why = queueableReason(board.find((b) => b.id === issue), DEFAULT_MAX_ATTEMPTS);
      // Refused at the door rather than queued and silently dropped by the
      // pump on its next tick, which is what a press with no answer looks like.
      if (why) return json(409, { error: why });
      if (!session.queue.some((q) => q.issue === issue)) {
        session.queue = [
          ...session.queue,
          { issue, tools, queuedAt: new Date().toISOString() },
        ];
        session.queueRev++;
        await saveQueue(resolved.projectDir, session.queue);
      }
      await pumpQueue(resolved);
      return json(200, { issue, queue: session.queue });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  // Taking an issue back out of the line. Also the way out of a queue whose
  // head was handed to an agent that never asked for a ruling, so it is not a
  // convenience: it is the escape hatch the advance condition needs.
  if (url.pathname === "/api/queue/remove" && req.method === "POST") {
    try {
      const { issue } = (await readJson(req)) as { issue?: string };
      if (!issue) throw new Error("no issue given");
      const next = session.queue.filter((q) => q.issue !== issue);
      if (next.length !== session.queue.length) {
        session.queue = next;
        session.queueRev++;
        await saveQueue(resolved.projectDir, next);
      }
      await pumpQueue(resolved);
      return json(200, { issue, queue: session.queue });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  // Ruling on the head by hand, when the agent it was handed to did not ask.
  if (url.pathname === "/api/rule" && req.method === "POST") {
    try {
      const { issue } = (await readJson(req)) as { issue?: string };
      if (!issue) throw new Error("no issue given");
      const r = startRuling(resolved, issue);
      return json(r.started ? 200 : 409, r);
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  // Filing an issue away, and putting it back. The page's only write to the
  // record, and a POST for the same reason `/api/queue` is one: it changes
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
