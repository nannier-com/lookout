/**
 * Small shared utilities: flag parsing, output, hashing, subprocess helpers.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Flags. A tiny map-based parser rather than a framework: verbs receive
// { flags, positionals } where flags holds --key=value, --key value, and
// boolean --key forms. List-valued flags are comma-separated strings the
// caller splits with list().
// ---------------------------------------------------------------------------

export interface Parsed {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseFlags(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    // A value follows unless it is another flag; bare flags are booleans.
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positionals };
}

export function list(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: string | boolean | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Output. Verbs build a result object; the CLI prints it as JSON (--json) or
// hands it to the verb's human formatter.
// ---------------------------------------------------------------------------

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Fixed-width two-column line for human output. */
export function row(label: string, value: string, width = 14): string {
  return `  ${label.padEnd(width)} ${value}`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function sha256(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function shortHash(buf: Buffer | Uint8Array): string {
  return sha256(buf).slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function runId(kind: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${kind}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Walk from `start` upward looking for `rel`; return the absolute path or null. */
export function findUp(rel: string, start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when a URL points at this machine. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Fetch with a timeout; returns the status or null when unreachable. The
 * default is generous because dev servers compile routes on first hit (a
 * cold Next.js page can take several seconds before its first byte).
 */
export async function probe(url: string, timeoutMs = 15_000): Promise<number | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
