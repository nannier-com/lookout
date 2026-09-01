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
 * No dependencies: node's own http server, and a page assembled under `src/ui`.
 * Bound to the loopback interface, because it serves screenshots of the user's
 * app. This file is the verb itself: resolve a project, listen, say where. What
 * answers each request lives beside it:
 *
 *   ui/routes.ts     which handler serves what
 *   ui/payload.ts    the board and the self-improvement record, and their caches
 *   ui/evidence.ts   screenshots and thumbnails of them
 *   ui/run.ts        the check the play button starts
 *   ui/project.ts    where lookout is pointed, and whether its targets answer
 *   ui/session.ts    the state one server process carries between requests
 *   ui/page.ts       the page itself
 */
import { createServer } from "node:http";
import { evidenceDir, loadConfig } from "../config.js";
import { handle } from "../ui/routes.js";
import { session, setCurrentProject } from "../ui/session.js";
import { loadSettings } from "../ui/stored-settings.js";
import { execFileAsync, num, str, type Parsed } from "../util.js";
import type { ResolvedConfig } from "../types.js";

// Re-exported because the page's own test reads it, and because `lookout ui`
// is the name of this thing however its parts are arranged.
export { pageHtml } from "../ui/page.js";

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
  console.log(`  watching ${evidenceDir(resolved)}`);
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
