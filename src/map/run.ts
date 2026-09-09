/**
 * One scan: the source, read by an AI with read-only access to the
 * repository, into `.lookout/map.json`.
 *
 * Per target, because a target is the unit `--targets` narrows and the unit
 * the walk resolves routes for. A target whose map is still fresh spends
 * nothing; one whose reply cannot be parsed keeps whatever it had, and the
 * failure is written down as an incident so `self-heal` and the learning
 * page see it.
 */
import { join } from "node:path";
import { repoRootOf } from "../design/detect.js";
import { hashText } from "../design/conformance-cache.js";
import { DEFAULT_JUDGE_MODEL, extractJson } from "../judge/engine.js";
import { adapterFor, invokeAi, isJudge, JUDGES, PRIMARY_AI } from "../judge/adapters.js";
import { detectProjectKind } from "../project-kind.js";
import { emit } from "../report/events.js";
import { recordIncident } from "../skills/incidents.js";
import { loadSkill } from "../skills/load.js";
import { resolveRoutes } from "../targets.js";
import { LookoutError, type PlatformKind, type ResolvedConfig } from "../types.js";
import { nowIso } from "../util.js";
import { mapCandidates, type MapCandidate } from "./candidates.js";
import { foldOf, parseMapReply } from "./parse.js";
import { readTextFromDisk, type ParseContext, type ParseTarget } from "./parse-node.js";
import { buildMapPrompt } from "./prompt.js";
import { candidatesHash, configHash, mapFreshness, mapSignature, skillHash, type ConfigSlice } from "./signature.js";
import {
  carryWalk,
  DEFAULT_MAP_FILE_BUDGET,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_SCREENS,
  loadMap,
  mapPath,
  saveMap,
  walkNodes,
  type MapFile,
  type MapTarget,
} from "./store.js";

export interface MapRunOptions {
  /** Target names to scan; every configured target when absent. */
  targets?: string[];
  /** Scan even a fresh map. */
  refresh?: boolean;
  /** The AI that reads; the primary when absent. */
  ai?: string;
  model?: string;
  maxScreens?: number;
  maxDepth?: number;
  log: (line: string) => void;
}

export interface TargetRun {
  name: string;
  status: "scanned" | "fresh" | "failed";
  /** Why it was scanned (what had moved), or why it failed. */
  reasons: string[];
  screens: number;
  routes: number;
  states: number;
  costUsd: number;
  notes: string[];
}

export interface MapRunResult {
  file: MapFile | null;
  path: string;
  targets: TargetRun[];
  costUsd: number;
}

/** The screens under a target's roots, and how many are routes. */
export function countScreens(target: MapTarget): { screens: number; routes: number; states: number } {
  let routes = 0;
  let states = 0;
  walkNodes(target.roots, (n) => {
    if (n.kind === "route") routes++;
    else states++;
  });
  return { screens: routes + states, routes, states };
}

function limitsOf(resolved: ResolvedConfig, opts: MapRunOptions): ParseContext["limits"] & { fileBudget: number } {
  const m = resolved.config.map ?? {};
  return {
    maxScreens: opts.maxScreens ?? m.maxScreens ?? DEFAULT_MAX_SCREENS,
    maxDepth: opts.maxDepth ?? m.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxChildren: m.maxChildren ?? DEFAULT_MAX_CHILDREN,
    fileBudget: m.fileBudget ?? DEFAULT_MAP_FILE_BUDGET,
  };
}

/** Who reads, refused rather than guessed when the AI has no adapter or no model. */
export function readerOf(opts: { ai?: string; model?: string }): { ai: string; model: string } {
  const ai = opts.ai ?? PRIMARY_AI;
  if (!isJudge(ai)) throw new LookoutError(`no AI adapter for "${ai}"`, `lookout can read with: ${JUDGES.join(", ")}`);
  const model = opts.model ?? (ai === PRIMARY_AI ? DEFAULT_JUDGE_MODEL : adapterFor(ai).defaultModel);
  if (!model) {
    throw new LookoutError(`--ai ${ai} names no model`, `pass --model <model>; lookout does not guess a model for ${ai}`);
  }
  return { ai, model };
}

export async function runMap(resolved: ResolvedConfig, opts: MapRunOptions): Promise<MapRunResult> {
  const { config } = resolved;
  const known = new Set(config.targets.map((t) => t.name));
  for (const name of opts.targets ?? []) {
    if (!known.has(name)) throw new LookoutError(`unknown target "${name}"`, `configured targets: ${[...known].join(", ")}`);
  }
  const selected = config.targets.filter((t) => !opts.targets || opts.targets.includes(t.name));
  const reader = readerOf(opts);
  const limits = limitsOf(resolved, opts);
  const skill = await loadSkill(resolved, "map-screens");
  const repoRoot = await repoRootOf(resolved.projectDir);
  const kind = await detectProjectKind(resolved.projectDir, config);
  const fold = foldOf([...(kind.web ? ["web"] : []), ...kind.native]);
  const candidates: MapCandidate[] = await mapCandidates(resolved, limits.fileBudget);
  const hashOf = (rel: string): string | null => {
    const text = readTextFromDisk(join(repoRoot, rel));
    return text === null ? null : hashText(text);
  };

  const existing = await loadMap(resolved);
  const file: MapFile = existing ?? { version: 1, project: resolved.project, targets: {} };
  const runs: TargetRun[] = [];
  let costUsd = 0;
  let scanned = 0;

  for (const def of selected) {
    const routes = resolveRoutes(def, config.element, resolved.configPath).map((r) => ({ path: r.path, name: r.name, states: r.states }));
    const target: ParseTarget = { name: def.name, url: def.url, routes };
    const slice: ConfigSlice = { url: def.url, routes: routes.map((r) => ({ path: r.path, states: r.states })) };
    const previous = file.targets[def.name];
    const freshness = mapFreshness({ target: previous, targetName: def.name, skill, configSlice: slice, candidates, hashOf });
    if (freshness.fresh && !opts.refresh && previous) {
      runs.push({ name: def.name, status: "fresh", reasons: [], ...countScreens(previous), costUsd: 0, notes: [] });
      continue;
    }
    const reasons = opts.refresh && freshness.fresh ? ["--refresh"] : freshness.reasons;
    opts.log(`map: scanning ${def.name} (${candidates.length} candidate file(s); ${reasons.join(", ")})`);
    emit("phase", `map: scanning ${def.name} (${candidates.length} candidate file(s))`, { target: def.name, candidates: candidates.length });

    const prompt = buildMapPrompt(skill.text, {
      project: resolved.project,
      targets: [target],
      platforms: fold.map((p) => ({
        kind: p,
        ...(p !== "web" && config.native?.[p]?.deepLinkScheme ? { deepLinkScheme: config.native[p]!.deepLinkScheme } : {}),
      })),
      configStates: Object.keys(config.states ?? {}),
      excluded: config.map?.exclude ?? [],
      candidates,
      limits,
    });
    let raw: unknown;
    let spent = 0;
    try {
      const reply = await invokeAi(reader.ai, {
        prompt,
        // The repository, because the question is about the repository: the
        // same exception the conformance reader and placement make.
        cwd: resolved.projectDir,
        model: reader.model,
        capabilities: ["read-files", "search-files"],
      });
      spent = reply.spend?.usd ?? 0;
      raw = extractJson(reply.text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordIncident({
        at: nowIso(),
        kind: "judge-unparseable",
        verb: "map",
        message: `screen map reply for ${def.name} could not be used: ${message}`,
        project: resolved.projectDir,
      });
      opts.log(`map: ${def.name}: ${message}${previous ? " (keeping the previous map)" : ""}`);
      runs.push({
        name: def.name,
        status: "failed",
        reasons: [message],
        ...(previous ? countScreens(previous) : { screens: 0, routes: 0, states: 0 }),
        costUsd: spent,
        notes: [],
      });
      costUsd += spent;
      continue;
    }
    costUsd += spent;

    const ctx: ParseContext = {
      targets: [target],
      recipeNames: new Set(Object.keys(config.states ?? {})),
      fold,
      projectDir: resolved.projectDir,
      repoRoot,
      limits,
      exclude: config.map?.exclude ?? [],
      readText: readTextFromDisk,
    };
    const parsed = parseMapReply(raw, ctx);
    const t = parsed.targets[def.name]!;
    if (t.fabricated > 0) {
      recordIncident({
        at: nowIso(),
        kind: "judge-rejected",
        verb: "map",
        message: `screen map for ${def.name} cited ${t.fabricated} file(s) or symbol(s) that do not exist`,
        detail: t.notes.filter((n) => /does not exist|is not in|outside the repository/.test(n)).join("\n").slice(0, 2000),
        project: resolved.projectDir,
      });
    }
    const candidatePaths = candidates.map((c) => c.relPath).sort();
    const next: MapTarget = {
      url: def.url,
      mappedAt: nowIso(),
      skillVersion: skill.version,
      ai: reader.ai,
      model: reader.model,
      signature: mapSignature({ skill, configSlice: slice, candidatePaths, examined: parsed.examined }),
      examined: parsed.examined,
      candidates: candidatePaths,
      configHash: configHash(slice),
      skillHash: skillHash(skill),
      roots: t.roots,
      skipped: t.skipped,
      notes: [...t.notes, ...parsed.notes],
    };
    carryWalk(previous, next);
    file.targets[def.name] = next;
    scanned++;
    const counts = countScreens(next);
    runs.push({ name: def.name, status: "scanned", reasons, ...counts, costUsd: spent, notes: next.notes });
    opts.log(`map: ${def.name}: ${counts.screens} screen(s) (${counts.routes} route(s), ${counts.states} state(s)); ~$${spent.toFixed(4)}`);
  }

  if (scanned > 0) await saveMap(resolved, file);
  return { file: scanned > 0 || existing ? file : null, path: mapPath(resolved), targets: runs, costUsd: Number(costUsd.toFixed(4)) };
}

/** The fold as a list, for callers that print it. */
export function foldPlatforms(kind: { web: boolean; native: readonly string[] }): PlatformKind[] {
  return foldOf([...(kind.web ? ["web"] : []), ...kind.native]);
}

export { candidatesHash };
