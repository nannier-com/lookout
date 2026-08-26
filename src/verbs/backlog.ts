/**
 * `lookout backlog <sub>`: the adjudication CLI over .lookout/backlog.json.
 *
 *   merge            ingest the latest capture-report (deterministic findings)
 *                    and judge-report (AI findings) into the backlog
 *   set <fp>         --status fixed|by-design|blocked|open [--reason ..] [--commit ..]
 *   reopen <fp>      shorthand for --status open
 *   regen            rewrite .lookout/BACKLOG.md from backlog.json
 *   check            validate schema, reasons, markdown freshness, drift; exit 1 on problems
 *                    stands, judging nothing (resume a fix loop for free)
 *   stats            counts by status and severity
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, lookoutDir } from "../config.js";
import { loadReport } from "../capture/store.js";
import {
  aiToFindings,
  checkBacklog,
  deterministicToFindings,
  emptyBacklog,
  mergeFindings,
  renderMarkdown,
  setStatus,
  stats,
  type Backlog,
} from "../backlog/lib.js";
import type { CheckOutcome } from "./check.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { nowIso, printJson, str, type Parsed } from "../util.js";

export function backlogPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "backlog.json");
}

export function markdownPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "BACKLOG.md");
}

export async function loadBacklog(resolved: ResolvedConfig): Promise<Backlog> {
  const p = backlogPath(resolved);
  if (!existsSync(p)) return emptyBacklog(resolved.project, nowIso());
  return JSON.parse(await readFile(p, "utf8")) as Backlog;
}

export async function saveBacklog(resolved: ResolvedConfig, backlog: Backlog): Promise<void> {
  const p = backlogPath(resolved);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(backlog, null, 2));
  await rename(tmp, p);
  await writeFile(markdownPath(resolved), renderMarkdown(backlog));
}

/** Merge the latest evidence + judge results; shared with `lookout check`. */
export async function mergeLatest(
  resolved: ResolvedConfig,
  opts: { judgeOutcome?: CheckOutcome | null },
): Promise<{ backlog: Backlog; added: number; reopened: number; refreshed: number }> {
  const report = await loadReport(resolved);
  if (!report) throw new LookoutError("no capture-report.json to merge from; run `lookout capture` first");
  const backlog = await loadBacklog(resolved);
  const now = nowIso();
  const latestRun = report.runs[report.runs.length - 1]!;

  // 1. Deterministic findings: free, every run, only from the latest run's shots.
  const latestShots = new Set(report.shots.filter((s) => s.runId === latestRun.id).map((s) => s.id));
  const det = deterministicToFindings({
    ...report,
    shots: report.shots.filter((s) => latestShots.has(s.id)),
  });
  const r1 = mergeFindings(backlog, det, latestRun.id, now);

  // 2. AI findings from the given or on-disk judge report.
  let judge = opts.judgeOutcome ?? null;
  if (!judge) {
    const jp = join(lookoutDir(resolved), "evidence", "judge-report.json");
    if (existsSync(jp)) judge = JSON.parse(await readFile(jp, "utf8")) as CheckOutcome;
  }
  let r2 = { added: [] as string[], reopened: [] as string[], refreshed: [] as string[], suppressed: [] as string[] };
  if (judge) {
    const shotsById = new Map(report.shots.map((s) => [s.id, s]));
    const ai = aiToFindings(judge.findings, shotsById);
    r2 = mergeFindings(backlog, ai, judge.runId, now);
  }

  await saveBacklog(resolved, backlog);
  return {
    backlog,
    added: r1.added.length + r2.added.length,
    reopened: r1.reopened.length + r2.reopened.length,
    refreshed: r1.refreshed.length + r2.refreshed.length,
  };
}

export async function backlog(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0] ?? "stats";
  const resolved = await loadConfig({ configPath: str(parsed.flags.config), url: str(parsed.flags.url) });

  if (sub === "merge") {
    const { backlog: b, added, reopened, refreshed } = await mergeLatest(resolved, {});
    const s = stats(b);
    console.log(
      `merged: ${added} added, ${reopened} reopened, ${refreshed} refreshed; ` +
        `${s.byStatus.open} open (${s.bySeverityOpen.critical} critical, ${s.bySeverityOpen.high} high)`,
    );
    return 0;
  }

  if (sub === "set" || sub === "reopen") {
    const fp = parsed.positionals[1];
    if (!fp) throw new LookoutError(`${sub} needs a fingerprint`);
    const status = sub === "reopen" ? "open" : str(parsed.flags.status);
    if (!status || !["open", "fixed", "by-design", "blocked"].includes(status)) {
      throw new LookoutError("set needs --status open|fixed|by-design|blocked");
    }
    const b = await loadBacklog(resolved);
    try {
      const f = setStatus(b, fp, status as "open", {
        reason: str(parsed.flags.reason),
        commit: str(parsed.flags.commit),
        runId: str(parsed.flags.run) ?? "manual",
        now: nowIso(),
      });
      await saveBacklog(resolved, b);
      console.log(`${f.fingerprint}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`);
      return 0;
    } catch (e) {
      throw new LookoutError((e as Error).message);
    }
  }

  if (sub === "regen") {
    const b = await loadBacklog(resolved);
    await saveBacklog(resolved, b);
    console.log(`wrote ${markdownPath(resolved)}`);
    return 0;
  }

  if (sub === "check") {
    const b = await loadBacklog(resolved);
    const mdPath = markdownPath(resolved);
    const md = existsSync(mdPath) ? await readFile(mdPath, "utf8") : null;
    const report = await loadReport(resolved);
    const problems = checkBacklog(b, { mdOnDisk: md, latestReport: report });
    if (parsed.flags.json) {
      printJson({ ok: problems.length === 0, problems });
    } else if (problems.length === 0) {
      console.log("backlog check: clean");
    } else {
      for (const p of problems) {
        console.log(`  [${p.kind}] ${p.fingerprint ?? ""} ${p.message}`);
      }
      console.log(`\n${problems.length} problem(s).`);
    }
    return problems.length === 0 ? 0 : 1;
  }

  if (sub === "stats") {
    const b = await loadBacklog(resolved);
    const s = stats(b);
    if (parsed.flags.json) {
      printJson(s);
    } else {
      console.log(
        `${s.total} finding(s): ${s.byStatus.open} open, ${s.byStatus.fixed} fixed, ` +
          `${s.byStatus["by-design"]} by design, ${s.byStatus.blocked} blocked` +
          `\nopen by severity: ${s.bySeverityOpen.critical} critical, ${s.bySeverityOpen.high} high, ` +
          `${s.bySeverityOpen.medium} medium, ${s.bySeverityOpen.low} low`,
      );
    }
    return 0;
  }

  throw new LookoutError(
    `unknown backlog subcommand "${sub}"`,
    "expected merge | set | reopen | plan | regen | check | stats",
  );
}
