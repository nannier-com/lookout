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
 *   ui/run.ts        the check the play button starts, and stops
 *   ui/project.ts    what the settings panel shows, and whether targets answer
 *   ui/session.ts    the state one server process carries between requests
 *   ui/page.ts       the page itself
 */
import { lookoutDir, loadConfig } from "../config.js";
import { locateConfig, nearestProjectRoot } from "../config-locate.js";
import { createConfig, ensureIgnored } from "../config-write.js";
import { live } from "../ui/live.js";
import { handle } from "../ui/routes.js";
import { stopCheck } from "../ui/run.js";
import { session, setCurrentProject } from "../ui/session.js";
import { startWatching, stopWatching } from "../ui/watch.js";
import { EMPTY_SETTINGS, loadSettings } from "../ui/stored-settings.js";
import { loadQueue, queueMtime } from "../ui/queue.js";
import { pumpQueue } from "../ui/queue-pump.js";
import { execFileAsync, num, str, type Parsed } from "../util.js";
import { LookoutError, type ResolvedConfig } from "../types.js";

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

/**
 * The project this server serves, and its config, written when there is none.
 *
 * `lookout ui` is a verb like any other now: it looks at the directory it was
 * started in. It used to be re-pointable at runtime and to remember where it
 * had been pointed, which is what put its settings in the operator's home;
 * with the settings inside the project, a page that could be re-pointed would
 * have to move its own storage mid-session for no gain over starting it in the
 * other directory.
 *
 * A project with no config gets one, rather than the refusal `ensureProjectConfig`
 * gives a verb that is about to go and look at something: this is the screen a
 * person configures a project ON, so stopping here to ask them to edit a file
 * and re-run is the wrong shape. A directory that is no project at all is
 * refused instead of littered.
 */
export async function projectToServe(parsed: Parsed): Promise<string | null> {
  if (str(parsed.flags.config) ?? str(parsed.flags.url)) return null;
  const cwd = process.cwd();
  const located = locateConfig(cwd);
  if (located) return located.projectDir;
  const root = nearestProjectRoot(cwd);
  if (!root) {
    throw new LookoutError(
      `no project here: ${cwd} holds no lookout.config.ts and is not a repository`,
      "run `lookout ui` from a project root, or pass --url for a one-off look",
    );
  }
  const path = await createConfig(root, {});
  await ensureIgnored(root);
  console.error(`lookout: wrote ${path}`);
  console.error("  set the base URL under the cog, or edit the file; the page reads it either way.");
  return root;
}

export async function ui(parsed: Parsed): Promise<number> {
  const root = await projectToServe(parsed);
  session.settings = root ? await loadSettings(root) : { ...EMPTY_SETTINGS };
  // The queue outlives the process that was holding it: a server restarted
  // mid-fix comes back still knowing what it was waiting for and what is behind
  // it. Its mtime comes with it, so a second server on the same project is
  // noticed rather than silently overwritten.
  session.queue = root ? await loadQueue(root) : [];
  session.queueMtime = root ? queueMtime(root) : 0;
  const baseUrl = str(parsed.flags["base-url"]) ?? session.settings.baseUrl ?? undefined;
  let resolved: ResolvedConfig;
  try {
    resolved = await loadConfig({
      configPath: str(parsed.flags.config),
      url: str(parsed.flags.url),
      baseUrl,
      ...(root ? { cwd: root } : {}),
    });
  } catch {
    // A config that will not load: serve the page anyway rather than leaving
    // the one screen that shows what lookout knows unopenable over a syntax
    // error in the file it was about to read.
    resolved = {
      config: { targets: [] },
      configPath: null,
      projectDir: root ?? process.cwd(),
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
  // A queue restored from disk may have been settled while nobody was serving
  // it, and its head may never have been handed over at all.
  void pumpQueue(resolved);

  const href = `http://127.0.0.1:${port}/`;
  console.log(`lookout ui: ${href}`);
  console.log(`  watching ${lookoutDir(resolved)}`);
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
      // A run started from the page has a process group of its own, so Ctrl-C
      // reaches this server and nothing else. Stopping it here is what keeps a
      // check, and the Claude CLI underneath it, from outliving the page that
      // asked for it: the signal is delivered before this process leaves.
      stopCheck();
      stopWatching();
      void server.stop();
      done();
    });
  });
  return 0;
}
