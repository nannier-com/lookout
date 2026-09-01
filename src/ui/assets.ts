/**
 * The page's own files: its stylesheets, and its script modules.
 *
 * These used to be strings compiled into the server. Serving them as files is
 * what lets them be real source: `client/` is type-checked with the rest of the
 * codebase and linted like it, and the browser loads the emitted modules
 * directly, so there is no bundler and nothing to keep in step.
 *
 * The directory is resolved against this module's own URL, which is `src/ui/`
 * in a checkout and `dist/ui/` in an install. The build emits the modules there
 * and copies the stylesheets beside them, so one path answers for both and
 * neither has to know which it is.
 *
 * From a checkout there is no emitted `.js` to serve, only the `.ts` it is
 * built from, and a browser cannot read that. Rather than make `lookout ui`
 * refuse to run until somebody remembers to build, the source is transpiled on
 * the way out: types stripped, nothing else touched. lookout already runs under
 * bun, so this costs a millisecond and no dependency, and it means the edit,
 * reload loop on this page needs no build step at all. An install never takes
 * that path, because the emitted file is right there.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { MIME, text } from "./http.js";

export function clientDir(): string {
  return fileURLToPath(new URL("./client/", import.meta.url));
}

/**
 * Flat names only.
 *
 * The client is one directory with no subdirectories, so a name that could
 * describe a path is a name that has no business here. This is the whole of the
 * traversal defence, and it is an allowlist rather than a check for "..",
 * because a browser can spell that several ways and an allowlist cannot be
 * spelled around.
 */
const SAFE_NAME = /^[a-z0-9-]+\.(css|js|map)$/i;

/**
 * Where an asset actually comes from, or null when nothing can answer for it.
 *
 * Exported because the page's test asks the same question: every file the shell
 * links has to be one this can find, and a stylesheet renamed without its link
 * should fail the build rather than the browser.
 */
export function clientAsset(name: string): { path: string; transpile: boolean } | null {
  if (!SAFE_NAME.test(name)) return null;
  const built = join(clientDir(), name);
  if (existsSync(built)) return { path: built, transpile: false };
  if (!name.endsWith(".js")) return null;
  const source = join(clientDir(), name.slice(0, -3) + ".ts");
  return existsSync(source) ? { path: source, transpile: true } : null;
}

export function serveClient(name: string): Response {
  const asset = clientAsset(name);
  if (!asset) {
    // Say which file is missing. A page whose script did not install is a blank
    // screen, and a blank screen with a 404 in a console nobody opened is the
    // hardest kind of failure to diagnose.
    return text(404, `lookout has no page asset ${name}; the install looks incomplete`);
  }
  const headers = {
    "content-type": MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
    // Never cached: a rebuild during a fix session has to reach the open tab on
    // a reload, and these files are read off local disk anyway.
    "cache-control": "no-store",
  };
  if (!asset.transpile) return new Response(Bun.file(asset.path), { headers });
  try {
    const ts = readFileSync(asset.path, "utf8");
    return new Response(
      new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(ts),
      { headers },
    );
  } catch (e) {
    return text(500, `lookout could not read ${name}: ${(e as Error).message}`);
  }
}
