/**
 * What the CLI installed on this machine is, and which models it will accept.
 *
 * The settings panel used to take a model as free text, on the reasoning that
 * a list of names baked into lookout would be wrong within a release while
 * still looking authoritative. That reasoning is still right, and this module
 * is what makes a menu possible without breaking it: nothing here is a list of
 * models, it is a way of ASKING the installed CLI for its own. A machine with a
 * newer CLI offers newer names, an older one offers older names, and lookout
 * states neither.
 *
 * Two questions, two sources, both belonging to the CLI rather than to lookout:
 *
 *   version   `--version`, which every CLI answers and which costs no model
 *             call. It is what the panel prints under the menu, so the person
 *             choosing can see WHICH install the names came from.
 *   models    the aliases the CLI documents for itself. Preferred source is the
 *             typings the package ships beside its binary, which carry the
 *             aliases as a real union type; the fallback is the `--model`
 *             paragraph of `--help`, which names them in prose.
 *
 * The fallback is not redundancy for its own sake. The typings are found by
 * walking up from the binary, and an install that puts the binary somewhere
 * else (a wrapper script, a package manager's shim) still answers `--help`.
 * When neither answers, this returns nothing and the panel falls back to the
 * text box: lookout does not invent a name it was not told.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { execFileAsync } from "../util.js";

/** What the installed CLI says about itself. */
export interface CliFacts {
  /** Its version, as it prints it, or null when it did not answer. */
  version: string | null;
  /** The model names it documents, or empty when it documents none. */
  models: string[];
}

/** The npm package a Claude Code install unpacks into. */
const PACKAGE = "@anthropic-ai/claude-code";

/** The typings that package ships, which carry the aliases as a union type. */
const TYPINGS = "sdk-tools.d.ts";

/** How far above the binary a package root is worth looking for. */
const CLIMB = 4;

/**
 * The version, from the CLI's own `--version`.
 *
 * Only the leading token is kept: the CLI prints its version followed by its
 * name in parentheses, and the panel is labelling a version rather than
 * repeating the product name it already sits under.
 */
export async function cliVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"]);
    const first = stdout.trim().split(/\s+/)[0];
    return first && /^[0-9]/.test(first) ? first : (stdout.trim() || null);
  } catch {
    // Not installed, not on PATH, or not answering. The panel says so already
    // through `installed`; there is no version to add to that.
    return null;
  }
}

/**
 * The package directory a binary was installed as part of, or null.
 *
 * Resolved through the real path first, because the thing on PATH is normally a
 * symlink into the package rather than the package's own file, and a walk up
 * from the link lands in a bin directory that knows nothing.
 */
async function packageRoot(bin: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(await absolutePath(bin));
  } catch {
    return null;
  }
  let dir = dirname(real);
  for (let i = 0; i < CLIMB; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
        if (name === PACKAGE) return dir;
      } catch {
        // A package.json that will not parse is not this package's.
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Where a bare command name actually lives, so it can be resolved. */
async function absolutePath(bin: string): Promise<string> {
  if (bin.includes("/")) return bin;
  // Same spelling `have` uses, `as never` included: the shell option is what
  // makes `command -v` resolvable and it is what the overload will not take.
  const { stdout } = await execFileAsync("command", ["-v", bin], { shell: true, encoding: "utf8" } as never);
  return String(stdout).trim();
}

/**
 * The aliases the shipped typings declare.
 *
 * Anchored on the field rather than on the union alone: a bare search for
 * quoted words joined by pipes would match any string union in a 160 kB
 * declaration file, and would start matching a different one the day the file
 * grows another. What is wanted is the field whose documented job is naming a
 * model, and its value is read from exactly that.
 */
function typedModels(root: string): string[] {
  const p = join(root, TYPINGS);
  if (!existsSync(p)) return [];
  try {
    const src = readFileSync(p, "utf8");
    const field = /\bmodel\??:\s*((?:"[A-Za-z0-9._:-]+"\s*\|\s*)+"[A-Za-z0-9._:-]+")\s*;/.exec(src);
    if (!field) return [];
    return unique([...field[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
  } catch {
    return [];
  }
}

/**
 * The aliases `--help` names, for an install whose typings were not found.
 *
 * The `--model` paragraph documents its aliases by quoting them, so the quoted
 * words in that paragraph are the answer. It is prose and it is incomplete by
 * construction (it says "e.g."), which is exactly why it is second: it is
 * better than an empty menu and worse than a declared type.
 */
async function helpModels(bin: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(bin, ["--help"]);
    // The option's own paragraph: from `--model` to the next option, so the
    // quoted names in a neighbouring flag's text cannot leak into the menu.
    const para = /--model\s+<[^>]*>([\s\S]*?)(?=\n\s*(?:-[a-zA-Z],\s)?--[a-z])/.exec(stdout);
    if (!para) return [];
    const quoted = [...para[1]!.matchAll(/'([A-Za-z0-9._:-]+)'/g)].map((m) => m[1]!);
    return unique(quoted);
  } catch {
    return [];
  }
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * Everything the panel needs about one installed CLI, asked once.
 *
 * The two questions are independent, so they are asked at the same time: a
 * panel that opened in the time of one subprocess should not take the time of
 * two. Neither can reject.
 */
export async function probeCli(bin: string): Promise<CliFacts> {
  const [version, root] = await Promise.all([cliVersion(bin), packageRoot(bin)]);
  const declared = root ? typedModels(root) : [];
  return { version, models: declared.length ? declared : await helpModels(bin) };
}
