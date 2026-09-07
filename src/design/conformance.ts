/**
 * Asking whether the application is actually built out of its kit.
 *
 * The deterministic scan in `detect.ts` answers a narrower question than most
 * people assume it does. It fires on a declaration whose NAME ends in a control
 * word, in a file that imports the kit NOWHERE. Both restrictions exist to keep
 * a regex honest, and together they blind it to the most common shape of the
 * defect: a screen that imports the kit for its text and its layout, and then
 * builds a button out of a styled div in the file next to it. No pattern can
 * tell that apart from legitimate scaffolding, because the difference is what
 * the thing IS, not what it is made of.
 *
 * So the reading is done by a skill, and this file is the run around it: work
 * out what has already been read, hand the rest over in batches, and fold what
 * comes back into one answer. The two jobs either side of that live next door.
 * `conformance-candidates` decides what is worth reading at all, and
 * `conformance-batch` puts one batch to the model and refuses to believe the
 * reply until every claim has been checked against the file it names.
 *
 * On reading the repository with a model. The visual judge is cwd-pinned to the
 * evidence directory with Read alone, so the target repository's own
 * instructions can never reach the thing deciding whether a defect exists. That
 * protection stays exactly as it is. This pass cannot have it: the question is
 * about source, and it has to open source to answer. What it has instead is
 * that nothing it says is taken on trust. Every finding names a file, a symbol
 * and a line, and each is verified against the file on disk before it is filed;
 * a claimed kit component that the kit does not export is rejected outright.
 * The failure a hostile repository could buy itself here is suppression, not
 * fabrication: it could talk the reader out of a finding, which is a thing it
 * could equally do by not writing the code in the first place.
 *
 * Read-only, always: Read, Grep and Glob. No Edit, no Write, no Bash.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  emptyCache,
  hashText,
  loadCache,
  readerIdentity,
  saveCache,
  type ConformanceCache,
} from "./conformance-cache.js";
import { loadSkill } from "../skills/load.js";
import { recordIncident } from "../skills/incidents.js";
import { conformanceCandidates, DEFAULT_FILE_BUDGET } from "./conformance-candidates.js";
import { readBatch, type BatchContext } from "./conformance-batch.js";
import { primaryKit, type DesignInventory, type HandRoll } from "./inventory.js";
import type {
  BatchOutcome,
  Candidate,
  ConformanceOptions,
  ConformanceResult,
} from "./conformance-types.js";
import type { ResolvedConfig } from "../types.js";
import { DEFAULT_JUDGE_MODEL } from "../judge/engine.js";

/** Files handed to one model call. Small enough that each one is actually read. */
const FILES_PER_BATCH = 8;

/** Batches in flight at once. Two, the same width the judge runs at. */
const BATCH_CONCURRENCY = 2;

/**
 * Read the application and say what it built for itself.
 *
 * Returns an empty result rather than throwing when the project has no kit:
 * with nothing to conform to there is no question to ask, and spending a model
 * call to be told so would be waste.
 */
export async function readConformance(
  resolved: ResolvedConfig,
  inv: DesignInventory,
  repoRoot: string,
  opts: ConformanceOptions = {},
): Promise<ConformanceResult> {
  const empty: ConformanceResult = {
    handRolls: [],
    refuted: [],
    examined: [],
    unread: [],
    cached: 0,
    considered: 0,
    rejected: [],
    costUsd: 0,
    calls: 0,
  };
  const kit = primaryKit(inv);
  if (!kit) return empty;

  let candidates = await conformanceCandidates(
    inv,
    repoRoot,
    Math.max(0, opts.fileBudget ?? DEFAULT_FILE_BUDGET),
  );
  if (opts.only) {
    const wanted = new Set(opts.only);
    candidates = candidates.filter((c) => wanted.has(c.path));
    // A file nobody would have chosen still has to be readable when it is named
    // outright, which is what ruling on one issue does.
    for (const path of opts.only) {
      if (candidates.some((c) => c.path === path) || !existsSync(path)) continue;
      let text = "";
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      candidates.push({
        path,
        relPath: relative(repoRoot, path),
        score: 0,
        suspicions: [],
        hash: hashText(text),
      });
    }
  }
  if (candidates.length === 0) return empty;

  const skill = await loadSkill(resolved, "kit-conformance");
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const result: ConformanceResult = { ...empty, considered: candidates.length };
  const byPath = new Map(candidates.map((c) => [c.path, c]));

  // What has already been read, and has not changed since. A file's bytes
  // cannot have grown a hand-rolled control while staying the same bytes, so a
  // hit is a verdict rather than a shortcut.
  const identity = readerIdentity(skill, model, kit.exports);
  const useCache = opts.cache !== false;
  const cache: ConformanceCache = useCache
    ? await loadCache(resolved, identity)
    : emptyCache(identity);
  const toRead: Candidate[] = [];
  for (const c of candidates) {
    const hit = cache.files[c.relPath];
    if (useCache && hit && hit.hash === c.hash) {
      result.handRolls.push(...hit.findings);
      result.refuted.push(...hit.refuted);
      result.examined.push(c.path);
      result.cached++;
      continue;
    }
    toRead.push(c);
  }

  const batches: Candidate[][] = [];
  for (let i = 0; i < toRead.length; i += FILES_PER_BATCH) {
    batches.push(toRead.slice(i, i + FILES_PER_BATCH));
  }

  // Everything a batch needs that does not change between batches, built once.
  const ctx: BatchContext = {
    resolved,
    skillText: skill.text,
    inv,
    model,
    byPath,
    kitExports: kit.exports,
  };

  // Two at a time, the same width the judge uses. These are subprocesses that
  // read files and think for a minute each; running a first sweep of forty
  // files strictly in series is several minutes of a person watching nothing.
  const outcomes: BatchOutcome[] = new Array(batches.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      outcomes[i] = await readBatch(ctx, batches[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, () => worker()),
  );

  // Folded in batch order, so the same repository gives the same report
  // whichever call happened to return first.
  for (const [i, out] of outcomes.entries()) {
    if (!out) continue;
    result.handRolls.push(...out.findings);
    result.refuted.push(...out.refuted);
    result.examined.push(...out.examined);
    result.unread.push(...out.unread);
    result.rejected.push(...out.rejected);
    result.costUsd += out.costUsd;
    result.calls += out.calls;
    for (const [relPath, decided] of out.decided) {
      const c = batches[i]!.find((b) => b.relPath === relPath);
      if (c) cache.files[relPath] = { hash: c.hash, ...decided };
    }
  }

  result.examined = [...new Set(result.examined)];
  result.unread = [...new Set(result.unread)].filter((p) => !result.examined.includes(p));
  // Full sweeps retire entries for files that left the tree: nothing can hit
  // them again (the key is the path, the hit needs the bytes), so they are
  // dead weight that would otherwise grow with every deleted screen. Entries
  // for existing files outside this run's budget are kept; budget rotation
  // can bring them back.
  let prunedEntries = 0;
  if (!opts.only && useCache) {
    for (const relPath of Object.keys(cache.files)) {
      if (!existsSync(join(repoRoot, relPath))) {
        delete cache.files[relPath];
        prunedEntries++;
      }
    }
  }
  result.prunedCache = prunedEntries;
  if (useCache && (result.calls > 0 || prunedEntries > 0)) await saveCache(resolved, cache);
  if (result.rejected.length > 0) {
    recordIncident({
      at: new Date().toISOString(),
      kind: "judge-rejected",
      verb: "conformance",
      message: `${result.rejected.length} conformance claim(s) rejected at ingestion`,
      detail: result.rejected
        .slice(0, 5)
        .map((r) => r.reason)
        .join("; "),
      project: resolved.projectDir,
    });
  }
  return result;
}

/**
 * The scan and the skill, merged into one list of hand-rolls.
 *
 * The skill outranks the scan on the files it read, in both directions: a
 * suspicion it refuted is dropped, and a control it found in a file the scan
 * had cleared is added. What it cannot do is un-file an issue that is already
 * open. Nothing in lookout closes a finding except a ruling on a claimed fix,
 * and a conformance sweep is not that; a refuted suspicion that has already
 * been filed is for a person to adjudicate by-design, with the skill's own
 * sentence as the reason.
 */
export function mergeHandRolls(scan: HandRoll[], read: ConformanceResult): HandRoll[] {
  const killed = new Set(read.refuted.map((r) => `${r.relPath}|${r.symbol}`));
  const kept = scan.filter((h) => !killed.has(`${h.relPath}|${h.symbol ?? ""}`));
  const seen = new Set(kept.map((h) => `${h.relPath}|${h.symbol ?? ""}`));
  for (const h of read.handRolls) {
    const key = `${h.relPath}|${h.symbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(h);
  }
  return kept;
}
