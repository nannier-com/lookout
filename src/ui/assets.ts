/**
 * The page's self-contained Vite bundle.
 *
 * Vite owns the browser dependency graph and emits React, React Native Web,
 * Canvas, and the client into one installable asset set. The server never asks
 * a package consumer to resolve those build inputs at runtime.
 *
 * An installed copy serves the bundle beside this module. A source checkout
 * serves `dist/ui/client`; before returning it, the checkout compares the
 * client source and Vite config mtimes with the emitted shell and rebuilds when
 * source is newer. This keeps edit and reload intact without making package
 * installs carry Vite or Canvas.
 *
 * The comparison is synchronous because page serving is synchronous and only
 * a checkout can enter it. Once built, ordinary requests are just stat calls.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { MIME, text } from "./http.js";

export function clientDir(): string {
  const beside = fileURLToPath(new URL("./client/", import.meta.url));
  if (!import.meta.url.endsWith("/src/ui/assets.ts")) return beside;
  const root = join(beside, "..", "..", "..");
  const built = join(root, "dist", "ui", "client");
  const shell = join(built, "shell.html");
  const emittedAt = existsSync(shell) ? statSync(shell).mtimeMs : 0;
  const sourceAt = Math.max(
    statSync(join(root, "vite.config.ts")).mtimeMs,
    ...readdirSync(beside).map((name) => statSync(join(beside, name)).mtimeMs),
  );
  if (sourceAt > emittedAt) {
    execFileSync(process.execPath, ["x", "vite", "build"], { cwd: root, stdio: "inherit" });
  }
  return built;
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
export function clientAsset(name: string): { path: string } | null {
  if (!SAFE_NAME.test(name)) return null;
  const built = join(clientDir(), name);
  return existsSync(built) ? { path: built } : null;
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
  return new Response(Bun.file(asset.path), { headers });
}
