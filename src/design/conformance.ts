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
 * So the reading is done by a skill, and this file is the machinery around it:
 * choose which files are worth a model's attention, hand them over in batches,
 * and refuse to believe the reply until each finding has been checked back
 * against the file it names.
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
import { relative } from "node:path";
import { extractJson, invokeClaude } from "../judge/engine.js";
import { loadSkill, renderSkill } from "../skills/load.js";
import { recordIncident } from "../skills/incidents.js";
import { appSourceFiles } from "./detect.js";
import { inventoryBrief } from "./placement.js";
import { primaryKit, type DesignInventory, type HandRoll } from "./inventory.js";
import type { ResolvedConfig } from "../types.js";

/** Files handed to one model call. Small enough that each one is actually read. */
const FILES_PER_BATCH = 8;

/** Files one run will look at, unless the caller says otherwise. */
export const DEFAULT_FILE_BUDGET = 40;

/** Raw elements that carry interaction, which is what a control is made of. */
const INTERACTIVE = /<(button|input|select|textarea|a)[\s/>]|onClick|onPress|role=["'](button|tab|dialog|switch|checkbox)/g;

/** Any raw element at all. */
const RAW = /<(div|span|button|input|select|textarea|label|a|ul|li|p|h[1-6])[\s/>]/g;

export interface ConformanceFinding extends HandRoll {
  foundBy: "skill";
  confidence: "high" | "medium" | "low";
}

/** A suspicion the skill looked at and killed. */
export interface Refutation {
  relPath: string;
  symbol: string;
  why: string;
}

export interface ConformanceResult {
  /** Hand-rolled controls the skill found and lookout could verify. */
  handRolls: ConformanceFinding[];
  /** Scanner suspicions the skill read and rejected. */
  refuted: Refutation[];
  /** Files the skill actually accounted for. */
  examined: string[];
  /** Files chosen for reading, whether or not the skill accounted for them. */
  considered: number;
  /** Claims thrown out because the file, the symbol or the export did not check out. */
  rejected: { reason: string; raw: unknown }[];
  costUsd: number;
  /** Model calls spent. */
  calls: number;
}

interface Candidate {
  path: string;
  relPath: string;
  /** Raw-element weight, for choosing what is worth reading. */
  score: number;
  /** What the deterministic scan suspected here, if anything. */
  suspicions: HandRoll[];
}

/** Files that exist to be read by a machine, or to demonstrate raw markup. */
const NOT_APPLICATION_UI = /\.(test|spec|stories|d)\.[tj]sx?$|\.generated\.|__(tests|mocks|snapshots)__/;

/**
 * Which files are worth a model's attention, worst offenders first.
 *
 * The ranking is the whole reason this is affordable. An application has
 * hundreds of source files and almost all of them are data, routing or
 * composition; the ones that hide a hand-rolled control are the ones dense in
 * raw interactive markup. Interaction counts triple because a styled div that
 * takes a click is a button by every definition except its tag.
 *
 * Files the scanner already suspects are pulled to the front regardless of
 * weight: those need a verdict either way, and a suspicion nobody rules on is a
 * finding filed on a regex's say-so.
 */
export async function conformanceCandidates(
  inv: DesignInventory,
  repoRoot: string,
  budget = DEFAULT_FILE_BUDGET,
): Promise<Candidate[]> {
  const kit = primaryKit(inv);
  if (!kit) return [];
  const kitRoots = [
    ...(kit.packageRoot && kit.packageRoot !== repoRoot ? [kit.packageRoot] : []),
    ...kit.componentRoots,
  ];
  const suspicionsByFile = new Map<string, HandRoll[]>();
  for (const h of inv.handRolls) {
    suspicionsByFile.set(h.path, [...(suspicionsByFile.get(h.path) ?? []), h]);
  }

  const out: Candidate[] = [];
  for (const file of await appSourceFiles(inv.appRoots)) {
    if (kitRoots.some((r) => file.startsWith(r + "/") || file === r)) continue;
    if (NOT_APPLICATION_UI.test(file)) continue;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const raw = [...text.matchAll(RAW)].length;
    if (raw === 0) continue;
    const interactive = [...text.matchAll(INTERACTIVE)].length;
    out.push({
      path: file,
      relPath: relative(repoRoot, file),
      score: raw + interactive * 3,
      suspicions: suspicionsByFile.get(file) ?? [],
    });
  }

  out.sort((a, b) => {
    if (a.suspicions.length !== b.suspicions.length) return b.suspicions.length - a.suspicions.length;
    return b.score - a.score;
  });
  return out.slice(0, budget);
}

/** The file list as the skill sees it: paths to open, and what was suspected. */
function fileBrief(batch: Candidate[]): string {
  const l: string[] = [];
  for (const c of batch) {
    l.push(`- ${c.path}`);
    for (const s of c.suspicions) {
      l.push(
        `    scanner suspects: ${s.symbol ?? "a component"} at line ${s.line}, built from ` +
          `<${s.elements.join(">, <")}>${s.candidate ? `, possibly duplicating ${s.candidate}` : ""}`,
      );
    }
  }
  return l.join("\n");
}

interface RawFinding {
  path?: unknown;
  symbol?: unknown;
  line?: unknown;
  elements?: unknown;
  kitComponent?: unknown;
  what?: unknown;
  why?: unknown;
  confidence?: unknown;
}

const CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * Turn one claim into a finding, or say why it cannot be one.
 *
 * Everything here is a check against the file on disk, because every one of
 * these has a failure mode that ends with somebody opening a file that does not
 * contain what they were told it contains. The line is the worst of them: a
 * model reading a long file will estimate, so the symbol is searched for and
 * the file's own answer wins over the reply's.
 */
export function verifyClaim(
  raw: RawFinding,
  text: string,
  candidate: Candidate,
  kitExports: string[],
): { ok: true; finding: ConformanceFinding } | { ok: false; reason: string } {
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim() : "";
  if (!symbol) return { ok: false, reason: "no symbol named" };

  // The declaration, found in the file rather than trusted from the reply.
  const decl = new RegExp(
    `(?:function|const|let|var|class)\\s+${symbol.replace(/[^A-Za-z0-9_$]/g, "")}\\b`,
  ).exec(text);
  if (!decl) {
    return { ok: false, reason: `${symbol} is not declared in ${candidate.relPath}` };
  }
  const line = text.slice(0, decl.index).split("\n").length;

  const claimed = typeof raw.kitComponent === "string" ? raw.kitComponent.trim() : null;
  // A kit component the kit does not export is the one claim that cannot be
  // softened into a note: it would send somebody looking for an import that
  // does not exist. The finding survives as a gap, which is what it is.
  const candidateExport =
    claimed && kitExports.length > 0 && kitExports.includes(claimed) ? claimed : null;

  const elements = Array.isArray(raw.elements)
    ? raw.elements.filter((e): e is string => typeof e === "string").slice(0, 6)
    : [];
  const confidence = CONFIDENCE.has(String(raw.confidence))
    ? (raw.confidence as "high" | "medium" | "low")
    : "medium";
  const what = typeof raw.what === "string" ? raw.what.trim() : "";
  const why = typeof raw.why === "string" ? raw.why.trim() : "";
  const note = [what, why].filter(Boolean).join(" ");
  if (!note) return { ok: false, reason: `${symbol} was filed with no account of what it is` };

  return {
    ok: true,
    finding: {
      path: candidate.path,
      relPath: candidate.relPath,
      symbol,
      elements,
      candidate: candidateExport,
      line,
      foundBy: "skill",
      note,
      confidence,
    },
  };
}

export interface ConformanceOptions {
  model?: string;
  /** How many files to read. Zero means every candidate. */
  fileBudget?: number;
  /** Read only these files, for ruling on one issue rather than sweeping. */
  only?: string[];
}

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
    opts.fileBudget === 0 ? Number.MAX_SAFE_INTEGER : (opts.fileBudget ?? DEFAULT_FILE_BUDGET),
  );
  if (opts.only) {
    const wanted = new Set(opts.only);
    candidates = candidates.filter((c) => wanted.has(c.path));
    // A file nobody would have chosen still has to be readable when it is named
    // outright, which is what ruling on one issue does.
    for (const path of opts.only) {
      if (candidates.some((c) => c.path === path) || !existsSync(path)) continue;
      candidates.push({ path, relPath: relative(repoRoot, path), score: 0, suspicions: [] });
    }
  }
  if (candidates.length === 0) return empty;

  const skill = await loadSkill(resolved, "kit-conformance");
  const model = opts.model ?? "sonnet";
  const result: ConformanceResult = { ...empty, considered: candidates.length };
  const byPath = new Map(candidates.map((c) => [c.path, c]));

  for (let i = 0; i < candidates.length; i += FILES_PER_BATCH) {
    const batch = candidates.slice(i, i + FILES_PER_BATCH);
    const prompt = renderSkill(skill.text, {
      project: resolved.project,
      kit: inventoryBrief(inv),
      files: fileBrief(batch),
    });

    let reply: { text: string; costUsd?: number };
    try {
      reply = await invokeClaude({
        prompt,
        // The repository, because the question is about the repository. The
        // note at the top of this file says why that is acceptable here and is
        // not acceptable for the visual judge.
        cwd: resolved.projectDir,
        model,
        allowedTools: ["Read", "Grep", "Glob"],
      });
    } catch (e) {
      // A batch failing is not the sweep failing. The files it covered are
      // simply not accounted for, which is reported rather than papered over.
      recordIncident({
        at: new Date().toISOString(),
        kind: "crash",
        verb: "conformance",
        message: `conformance batch failed: ${e instanceof Error ? e.message : String(e)}`,
        project: resolved.project,
      });
      continue;
    }
    result.calls++;
    result.costUsd += reply.costUsd ?? 0;

    let parsed: { findings?: unknown; refuted?: unknown; examined?: unknown };
    try {
      parsed = extractJson(reply.text) as typeof parsed;
    } catch {
      recordIncident({
        at: new Date().toISOString(),
        kind: "judge-unparseable",
        verb: "conformance",
        message: "conformance reply was not JSON",
        detail: reply.text.slice(0, 400),
        project: resolved.project,
      });
      continue;
    }

    for (const raw of Array.isArray(parsed.findings) ? parsed.findings : []) {
      const claim = raw as RawFinding;
      const path = typeof claim.path === "string" ? claim.path : "";
      const candidate = byPath.get(path);
      if (!candidate) {
        result.rejected.push({ reason: "names a file that was not in the batch", raw });
        continue;
      }
      let text: string;
      try {
        text = await readFile(candidate.path, "utf8");
      } catch {
        result.rejected.push({ reason: `${candidate.relPath} could not be read back`, raw });
        continue;
      }
      const checked = verifyClaim(claim, text, candidate, kit.exports);
      if (!checked.ok) {
        result.rejected.push({ reason: checked.reason, raw });
        continue;
      }
      // One finding per control. A model asked about a file twice in one reply
      // is describing the same component from two angles.
      if (
        result.handRolls.some(
          (h) => h.path === checked.finding.path && h.symbol === checked.finding.symbol,
        )
      ) {
        continue;
      }
      result.handRolls.push(checked.finding);
      result.examined.push(candidate.path);
    }

    for (const raw of Array.isArray(parsed.refuted) ? parsed.refuted : []) {
      const r = raw as { path?: unknown; symbol?: unknown; why?: unknown };
      const candidate = byPath.get(typeof r.path === "string" ? r.path : "");
      if (!candidate || typeof r.symbol !== "string") continue;
      result.refuted.push({
        relPath: candidate.relPath,
        symbol: r.symbol,
        why: typeof r.why === "string" ? r.why : "",
      });
      result.examined.push(candidate.path);
    }

    for (const raw of Array.isArray(parsed.examined) ? parsed.examined : []) {
      if (typeof raw === "string" && byPath.has(raw)) result.examined.push(raw);
    }
  }

  result.examined = [...new Set(result.examined)];
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
      project: resolved.project,
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
