/**
 * What the conformance reader already knows about a file.
 *
 * The sweep is on by default, and a pass that re-reads the same forty
 * unchanged files on every run would be a tax nobody keeps paying: people turn
 * off the thing that costs money for no new answer. But a file that has not
 * changed cannot have grown a hand-rolled control since the last read, so the
 * previous verdict is still the verdict.
 *
 * Keyed on the file's own bytes plus an identity for everything that could
 * change the answer without the file changing: the composed skill text (a
 * project amendment with no version field changes the prompt and nothing
 * else), the skill's version (kept for humans reading the file), the model
 * (a verdict is that model's verdict), and the kit's export list, because
 * what the kit provides is half of every finding here. Move any of those and
 * every cached verdict is dropped, which is the same bargain the judge ledger
 * makes with the rubric; the ledger learned the hard way that a version-only
 * key leaves the prompt and the model free to move under it.
 *
 * A cache miss costs a model call. A stale hit would cost a wrong answer, so
 * everything here fails toward the miss.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lookoutDir } from "../config.js";
import { atomicWriteJson } from "../state/atomic.js";
import { withStateLock } from "../state/lock.js";
import type { ConformanceFinding, Refutation } from "./conformance-types.js";
import type { ResolvedConfig } from "../types.js";

export interface CachedRead {
  /** Hash of the file's bytes when it was read. */
  hash: string;
  findings: ConformanceFinding[];
  refuted: Refutation[];
}

export interface ConformanceCache {
  schema: 1;
  /** Identity of the reader that produced these verdicts. */
  identity: string;
  /** Keyed by repo-relative path, so a moved checkout keeps its cache. */
  files: Record<string, CachedRead>;
}

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** Everything that changes the answer without changing the file. */
export function readerIdentity(
  skill: { version: number; text: string },
  model: string,
  kitExports: string[],
): string {
  return hashText(
    `v${skill.version}|p:${hashText(skill.text)}|m:${model}|x:${[...kitExports].sort().join(",")}`,
  );
}

export function cachePath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "conformance.json");
}

export function emptyCache(identity: string): ConformanceCache {
  return { schema: 1, identity, files: {} };
}

/**
 * The cache, or an empty one. A cache written by a different reader is
 * discarded whole rather than partially trusted: the identity is exactly the
 * set of things that could make every entry in it wrong at once.
 */
export async function loadCache(
  resolved: ResolvedConfig,
  identity: string,
): Promise<ConformanceCache> {
  const p = cachePath(resolved);
  if (!existsSync(p)) return emptyCache(identity);
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as ConformanceCache;
    if (raw?.schema !== 1 || raw.identity !== identity) return emptyCache(identity);
    return raw;
  } catch {
    return emptyCache(identity);
  }
}

export async function saveCache(
  resolved: ResolvedConfig,
  cache: ConformanceCache,
): Promise<string> {
  const p = cachePath(resolved);
  await withStateLock(resolved, "design", async () => atomicWriteJson(p, cache));
  return p;
}
