/**
 * `lookout ui`: the issues lookout has found, with the pixels that prove them.
 *
 * lookout finds issues and documents them. This is where that documentation is
 * read. It is built from the backlog, which outlives any run, so it shows what
 * is outstanding whether or not anything is executing; the event log is laid
 * over the top only to say what is happening this second.
 *
 * Every card owns its evidence: the screenshots the defect was filed against,
 * the screenshots that prove them, and every path in absolute form, because the
 * point of the page is to hand an issue to somebody who then has to go and open
 * those files.
 *
 * It starts nothing it was not asked to start, judges nothing and dispatches
 * nothing, which means it can be left open across runs and costs nothing to
 * keep around.
 *
 * No dependencies: bun's own server, and a page assembled under `src/ui`. Bound
 * to the loopback interface, because it serves screenshots of the user's app.
 * This file is the verb itself: resolve a project, listen, say where. What
 * answers each request lives beside it:
 *
 *   ui/routes.ts     which handler serves what
 *   ui/payload.ts    the board and the self-improvement record, and their caches
 *   ui/live.ts       the socket the page holds open, and what is written down it
 *   ui/watch.ts      noticing a run wrote something, so the socket can say so
 *   ui/evidence.ts   screenshots and thumbnails of them
 *   ui/run.ts        the check the play button starts
 *   ui/project.ts    where lookout is pointed, and whether its targets answer
 *   ui/session.ts    the state one server process carries between requests
 *   ui/page.ts       the page itself
 */
import { evidenceDir, loadConfig } from "../config.js";
import { live } from "../ui/live.js";
import { handle } from "../ui/routes.js";
import { session, setCurrentProject } from "../ui/session.js";
import { startWatching, stopWatching } from "../ui/watch.js";
import { loadSettings } from "../ui/stored-settings.js";
import { execFileAsync, num, str, type Parsed } from "../util.js";
import type { ResolvedConfig } from "../types.js";

// Re-exported because the page's own test reads it, and because `lookout ui`
// is the name of this thing however its parts are arranged.
export { pageHtml } from "../ui/page.js";

/**
 * How long a request may go quiet before bun closes the connection under it.
 *
 * This is the HTTP inactivity timeout, not the socket's: the socket's own lives
 * on the `websocket` handler object and defaults to two minutes, which bun's
 * automatic pings keep resetting. Setting a value at this level does nothing
 * for the page's socket at all.
 *
 * It is bun's maximum because one handler here waits on a person rather than on
 * a computer: `POST /api/pick` opens a native folder picker and does not answer
 * until somebody has chosen a directory. bun's default of ten seconds closes
 * the connection under exactly that. Measured on bun 1.3.14: a handler that
 * takes fourteen seconds is cut off at ten and the caller's fetch rejects with
 * "the socket connection was closed unexpectedly". node's server, which this
 * replaced, imposed no such limit, so leaving this unset is a regression rather
 * than a default.
 *
 * Exported so the floor can be asserted: what matters is not the exact number
 * but that it is far longer than a person takes to pick a folder.
 */
export const HTTP_IDLE_SECONDS = 255;

export async function ui(parsed: Parsed): Promise<number> {
  // The page is where lookout gets configured now, so the server has to be able
  // to start with nothing configured. It used to refuse, which meant the one
  // screen that can fix an unconfigured project could not be opened until the
  // project was already configured.
  session.settings = await loadSettings();
  const explicit = str(parsed.flags.config) ?? str(parsed.flags.url);
  const baseUrl = str(parsed.flags["base-url"]) ?? session.settings.baseUrl ?? undefined;
  const startIn = explicit ? undefined : session.settings.projectDir ?? undefined;
  let resolved: ResolvedConfig;
  try {
    resolved = await loadConfig({
      configPath: str(parsed.flags.config),
      url: str(parsed.flags.url),
      baseUrl,
      ...(startIn ? { cwd: startIn } : {}),
    });
    if (resolved.configPath) session.settings.projectDir = resolved.projectDir;
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
  setCurrentProject(resolved);
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: HTTP_IDLE_SECONDS,
    async fetch(req, self) {
      try {
        return await handle(req, self);
      } catch {
        return new Response("error", { status: 500 });
      }
    },
    websocket: live,
  });

  // Now that there is somewhere to push to, start noticing that runs are
  // writing. Nothing is pushed until a page actually opens a socket.
  startWatching();

  const href = `http://127.0.0.1:${port}/`;
  console.log(`lookout ui: ${href}`);
  console.log(`  watching ${evidenceDir(resolved)}`);
  console.log("  it reads the backlog, so it shows every open issue, run or no run.");
  console.log("  findings appear as they land, pushed over a socket, not polled.");
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
      stopWatching();
      void server.stop();
      done();
    });
  });
  return 0;
}
