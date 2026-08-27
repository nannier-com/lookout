/**
 * The judge engine: shells out to the locally installed Claude Code CLI
 * (`claude -p`) with read-only tool access, cwd-pinned to the evidence
 * directory so the target repo's instructions never leak into judging.
 *
 * The subprocess reads the screenshot files itself (vision via the Read
 * tool); lookout passes paths plus a manifest and demands a strict JSON
 * reply, retrying once with a harder instruction when parsing fails.
 */
import { execFile } from "node:child_process";
import { LookoutError, type Severity, type ShotRecord } from "../types.js";
import { renderSkill } from "../skills/load.js";
import { CATEGORIES, SEVERITIES, type Category } from "./rubric.js";

export interface JudgeInvocation {
  prompt: string;
  cwd: string;
  model: string;
  timeoutMs?: number;
}

export interface AiFinding {
  shotId: string;
  category: Category;
  attribute: string;
  severity: Severity;
  title: string;
  problem: string;
  expected: string;
  observed: string;
  confidence: "high" | "medium" | "low";
  /** What would prove this defect gone, in the judge's own words. */
  acceptance: string[];
}

export interface JudgeBatchResult {
  findings: AiFinding[];
  cleanShotIds: string[];
  rejected: { reason: string; raw: unknown }[];
  raw: string;
  costUsd?: number;
  durationMs: number;
}

/**
 * The claude binary: overridable for nonstandard install paths and for test
 * doubles. The judge otherwise assumes `claude` on PATH, logged in (run
 * `claude` interactively once; `lookout doctor --handshake` verifies).
 */
export function claudeBin(): string {
  return process.env.LOOKOUT_CLAUDE_BIN ?? "claude";
}

/** One `claude -p` round-trip returning the reply text. */
export function invokeClaude(inv: JudgeInvocation): Promise<{ text: string; costUsd?: number }> {
  const args = [
    "-p",
    inv.prompt,
    "--output-format",
    "json",
    "--allowedTools",
    "Read",
    "--model",
    inv.model,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      args,
      { cwd: inv.cwd, timeout: inv.timeoutMs ?? 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new LookoutError(
              `claude -p failed: ${err.message.slice(0, 300)}`,
              stderr ? `stderr: ${stderr.slice(0, 300)}` : "is Claude Code logged in? run `claude` once interactively",
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            result?: string;
            total_cost_usd?: number;
            is_error?: boolean;
            subtype?: string;
          };
          if (typeof parsed.result !== "string") {
            reject(new LookoutError(`claude -p returned no result (subtype: ${parsed.subtype ?? "?"})`));
            return;
          }
          if (parsed.is_error) {
            reject(
              new LookoutError(
                `claude -p errored: ${parsed.result.slice(0, 200)}`,
                /not logged in/i.test(parsed.result)
                  ? "run `claude` in a terminal once and complete /login, then retry (verify with `lookout doctor --handshake`)"
                  : undefined,
              ),
            );
            return;
          }
          resolve({ text: parsed.result, costUsd: parsed.total_cost_usd });
        } catch {
          reject(new LookoutError(`claude -p produced unparseable output: ${stdout.slice(0, 300)}`));
        }
      },
    );
  });
}

/** Extract the last fenced json block (or a bare object) from a reply. */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidate = fences.length > 0 ? fences[fences.length - 1]![1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * The judge prompt: the visual-judge skill, filled with this batch's data.
 *
 * Everything the model is told to think lives in the skill file; everything
 * here is fact about the evidence.
 */
export function buildJudgePrompt(
  skillText: string,
  project: string,
  shots: ShotRecord[],
  evidenceDir: string,
): string {
  const manifest = shots
    .map(
      (s) =>
        `- shotId: ${s.id}\n  file: ${evidenceDir}/${s.path}\n  route: ${s.route} (${s.routeName})  state: ${s.state}  formFactor: ${s.formFactor}  scheme: ${s.scheme}  size: ${s.width}x${s.height}` +
        (s.design ? `\n  design: ${s.design}` : ""),
    )
    .join("\n");
  return renderSkill(skillText, { project, shotCount: shots.length, manifest });
}

const RETRY_SUFFIX =
  "\n\nYour previous reply could not be parsed. Reply with NOTHING but the fenced ```json block.";

export async function judgeBatch(
  skillText: string,
  project: string,
  shots: ShotRecord[],
  evidenceDir: string,
  model: string,
): Promise<JudgeBatchResult> {
  const started = Date.now();
  const prompt = buildJudgePrompt(skillText, project, shots, evidenceDir);

  let text = "";
  let costUsd: number | undefined;
  let parsed: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await invokeClaude({
      prompt: attempt === 0 ? prompt : prompt + RETRY_SUFFIX,
      cwd: evidenceDir,
      model,
    });
    text = res.text;
    costUsd = (costUsd ?? 0) + (res.costUsd ?? 0);
    try {
      parsed = extractJson(text);
      break;
    } catch {
      if (attempt === 1) {
        throw new LookoutError(
          "judge reply was not parseable JSON after a retry",
          `reply head: ${text.slice(0, 200)}`,
        );
      }
    }
  }

  const known = new Set(shots.map((s) => s.id));
  const findings: AiFinding[] = [];
  const rejected: { reason: string; raw: unknown }[] = [];
  const obj = parsed as { findings?: unknown; cleanShotIds?: unknown };
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  for (const f of rawFindings) {
    const r = f as Record<string, unknown>;
    const category = String(r.category ?? "");
    const severity = String(r.severity ?? "");
    const shotId = String(r.shotId ?? "");
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      rejected.push({ reason: `unknown category "${category}"`, raw: f });
      continue;
    }
    if (!(SEVERITIES as readonly string[]).includes(severity)) {
      rejected.push({ reason: `unknown severity "${severity}"`, raw: f });
      continue;
    }
    if (!known.has(shotId)) {
      rejected.push({ reason: `unknown shotId "${shotId}"`, raw: f });
      continue;
    }
    findings.push({
      shotId,
      category: category as Category,
      attribute: kebab(String(r.attribute ?? "general")),
      severity: severity as Severity,
      title: String(r.title ?? "").slice(0, 200),
      problem: String(r.problem ?? "").slice(0, 1500),
      expected: String(r.expected ?? "").slice(0, 800),
      observed: String(r.observed ?? "").slice(0, 800),
      confidence: (["high", "medium", "low"] as const).includes(
        r.confidence as "high" | "medium" | "low",
      )
        ? (r.confidence as "high" | "medium" | "low")
        : "medium",
      // Capped and trimmed: this is a checklist somebody reads, and a judge
      // that returns a paragraph per entry has written prose, not a criterion.
      acceptance: (Array.isArray(r.acceptance) ? r.acceptance : [])
        .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
        .slice(0, 6)
        .map((a) => a.trim().slice(0, 300)),
    });
  }
  const cleanShotIds = (Array.isArray(obj.cleanShotIds) ? obj.cleanShotIds : [])
    .map(String)
    .filter((id) => known.has(id));

  return { findings, cleanShotIds, rejected, raw: text, costUsd, durationMs: Date.now() - started };
}

function kebab(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

/** Pack shots into judge batches: same target+route stays together, max size. */
/** The view a shot belongs to: everything the rubric compares across. */
export function viewGroupId(shot: ShotRecord): string {
  return `${shot.target}|${shot.platform}|${shot.route}|${shot.state}`;
}

/** Partition shots into view groups, preserving encounter order. */
export function groupShots(shots: ShotRecord[]): Map<string, ShotRecord[]> {
  const groups = new Map<string, ShotRecord[]>();
  for (const s of shots) {
    const id = viewGroupId(s);
    const arr = groups.get(id) ?? [];
    arr.push(s);
    groups.set(id, arr);
  }
  return groups;
}

/**
 * Pack shots into judge batches with the VIEW GROUP as the atomic unit. The
 * rubric compares a view's schemes and form factors against each other, so a
 * group must never straddle two batches: an oversized group ships alone and
 * whole rather than being split.
 */
export function batchShots(shots: ShotRecord[], maxPerBatch = 10): ShotRecord[][] {
  const batches: ShotRecord[][] = [];
  let current: ShotRecord[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
  };
  for (const group of groupShots(shots).values()) {
    if (group.length >= maxPerBatch) {
      flush();
      batches.push(group);
      continue;
    }
    if (current.length + group.length > maxPerBatch) flush();
    current.push(...group);
  }
  flush();
  return batches;
}
