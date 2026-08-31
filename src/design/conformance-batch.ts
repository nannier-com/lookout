/**
 * One batch of files, put to the model, and the checking of what comes back.
 *
 * The pass is built on not believing the reply. Every claim names a file, a
 * symbol and a line, and each of those is verified against the file on disk
 * before it becomes a finding: the file must be one this batch actually
 * offered, the symbol must be declared in it, and a kit component the kit does
 * not export is dropped rather than repeated. What survives all of that is a
 * finding; what does not is recorded as rejected, because a reader that keeps
 * failing these checks is a reader whose instructions need fixing.
 */
import { readFile } from "node:fs/promises";
import { extractJson, invokeClaude } from "../judge/engine.js";
import { renderSkill } from "../skills/load.js";
import { recordIncident } from "../skills/incidents.js";
import { fileBrief } from "./conformance-candidates.js";
import { inventoryBrief } from "./placement.js";
import type { DesignInventory } from "./inventory.js";
import type {
  BatchOutcome,
  Candidate,
  ConformanceFinding,
  RawFinding,
} from "./conformance-types.js";
import type { ResolvedConfig } from "../types.js";

/** Everything one batch needs that is the same for every batch in a run. */
export interface BatchContext {
  resolved: ResolvedConfig;
  /** The composed skill text, loaded once so two batches cannot be asked differently. */
  skillText: string;
  /** The project's design system, as the skill is shown it. */
  inv: DesignInventory;
  model: string;
  /** Every file this run chose, by absolute path: what a reply may name. */
  byPath: Map<string, Candidate>;
  /** What the kit exports, for checking a claimed component against reality. */
  kitExports: string[];
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
  // An identifier, or nothing. Sanitising a symbol down to the empty string and
  // searching for that would match the first declaration in the file and file a
  // finding against a component nobody named.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
    return { ok: false, reason: symbol ? `"${symbol}" is not an identifier` : "no symbol named" };
  }

  // The declaration, found in the file rather than trusted from the reply.
  const decl = new RegExp(`(?:function|const|let|var|class)\\s+${symbol}\\b`).exec(text);
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
  // What it is and why it counts, as two sentences rather than one run-on. This
  // text lands in the issue a person reads, so it is punctuated here rather
  // than hoping the reply punctuated itself.
  const parts = [raw.what, raw.why]
    .map((t) => (typeof t === "string" ? t.trim().replace(/[.;,\s]+$/, "") : ""))
    .filter(Boolean);
  const note = parts.length > 0 ? `${parts.join(". ")}.` : "";
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

/**
 * One model call, and everything that survived checking it.
 *
 * A batch is its own unit of failure. Nothing it produces reaches the run's
 * result without being checked back against the file it names, and a batch that
 * fails, or comes back as something other than JSON, reports the files it
 * covered as unread rather than as clean.
 */
export async function readBatch(ctx: BatchContext, batch: Candidate[]): Promise<BatchOutcome> {
  const out: BatchOutcome = {
    findings: [],
    refuted: [],
    examined: [],
    unread: [],
    rejected: [],
    decided: new Map(),
    costUsd: 0,
    calls: 0,
  };
  const entryFor = (relPath: string) => {
    const e = out.decided.get(relPath) ?? { findings: [], refuted: [] };
    out.decided.set(relPath, e);
    return e;
  };
  const prompt = renderSkill(ctx.skillText, {
    project: ctx.resolved.project,
    kit: inventoryBrief(ctx.inv),
    files: fileBrief(batch),
  });

  let reply: { text: string; costUsd?: number };
  try {
    reply = await invokeClaude({
      prompt,
      // The repository, because the question is about the repository. The
      // note at the top of this file says why that is acceptable here and is
      // not acceptable for the visual judge.
      cwd: ctx.resolved.projectDir,
      model: ctx.model,
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
      project: ctx.resolved.project,
    });
    out.unread.push(...batch.map((c) => c.path));
    return out;
  }
  out.calls++;
  out.costUsd += reply.costUsd ?? 0;

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
      project: ctx.resolved.project,
    });
    out.unread.push(...batch.map((c) => c.path));
    return out;
  }

  for (const raw of Array.isArray(parsed.findings) ? parsed.findings : []) {
    const claim = raw as RawFinding;
    const path = typeof claim.path === "string" ? claim.path : "";
    const candidate = ctx.byPath.get(path);
    if (!candidate) {
      out.rejected.push({ reason: "names a file that was not in the batch", raw });
      continue;
    }
    let text: string;
    try {
      text = await readFile(candidate.path, "utf8");
    } catch {
      out.rejected.push({ reason: `${candidate.relPath} could not be read back`, raw });
      continue;
    }
    const checked = verifyClaim(claim, text, candidate, ctx.kitExports);
    if (!checked.ok) {
      out.rejected.push({ reason: checked.reason, raw });
      continue;
    }
    // One finding per control. A model asked about a file twice in one reply
    // is describing the same component from two angles.
    if (
      out.findings.some(
        (h) => h.path === checked.finding.path && h.symbol === checked.finding.symbol,
      )
    ) {
      continue;
    }
    out.findings.push(checked.finding);
    out.examined.push(candidate.path);
    entryFor(candidate.relPath).findings.push(checked.finding);
  }

  for (const raw of Array.isArray(parsed.refuted) ? parsed.refuted : []) {
    const r = raw as { path?: unknown; symbol?: unknown; why?: unknown };
    const candidate = ctx.byPath.get(typeof r.path === "string" ? r.path : "");
    if (!candidate || typeof r.symbol !== "string") continue;
    // A reply that files a control and refutes it in the same breath has said
    // nothing. The finding is the assertive half and it stands; the
    // contradiction is recorded, because a reader doing this often is a
    // reader whose instructions need fixing.
    if (out.findings.some((h) => h.path === candidate.path && h.symbol === r.symbol)) {
      out.rejected.push({
        reason: `${r.symbol} was filed and refuted in the same reply`,
        raw,
      });
      continue;
    }
    const refutation = {
      relPath: candidate.relPath,
      symbol: r.symbol,
      why: typeof r.why === "string" ? r.why : "",
    };
    out.refuted.push(refutation);
    out.examined.push(candidate.path);
    entryFor(candidate.relPath).refuted.push(refutation);
  }

  for (const raw of Array.isArray(parsed.examined) ? parsed.examined : []) {
    const candidate = typeof raw === "string" ? ctx.byPath.get(raw) : undefined;
    if (!candidate) continue;
    out.examined.push(candidate.path);
    entryFor(candidate.relPath);
  }

  // A file the reply accounted for nowhere has no verdict. Caching it as
  // clean would turn silence into a durable clean bill of health, so it is
  // recorded as unread and asked about again next run.
  for (const c of batch) {
    if (!out.decided.has(c.relPath)) out.unread.push(c.path);
  }
  return out;
}
