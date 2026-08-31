/**
 * `lookout backlog <sub>`: the adjudication CLI over .lookout/backlog.json.
 *
 *   merge            ingest the latest capture-report (deterministic findings)
 *                    and judge-report (AI findings) into the backlog
 *   set <fp>         --status fixed|by-design|blocked|open [--reason ..] [--commit ..]
 *   reopen <fp>      shorthand for --status open
 *   regen            rewrite .lookout/BACKLOG.md from backlog.json
 *   check            validate schema, reasons, markdown freshness, drift; exit 1 on problems
 *   stats            counts by status and severity
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, lookoutDir } from "../config.js";
import { loadReport } from "../capture/store.js";
import { reconcileIssues } from "../issues/registry.js";
import { materializeIssues } from "../issues/store.js";
import { loadFrames } from "../issues/frames.js";
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
import { emit } from "../report/events.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { nowIso, printJson, str, type Parsed } from "../util.js";

export function backlogPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "backlog.json");
}

export function markdownPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "BACKLOG.md");
}

/**
 * The backlog, with every root cause holding an id.
 *
 * Reconciling on load repairs a backlog written before ids existed, and writes
 * the repair straight back: an id drawn at random and then forgotten would come
 * back different next time, and the folder named after the first one would be
 * orphaned. Minting happens here and in save, and nowhere else.
 */
export async function loadBacklog(resolved: ResolvedConfig): Promise<Backlog> {
  const p = backlogPath(resolved);
  if (!existsSync(p)) return emptyBacklog(resolved.project, nowIso());
  const backlog = JSON.parse(await readFile(p, "utf8")) as Backlog;
  const minted = reconcileIssues(backlog, nowIso());
  if (minted.length > 0) await saveBacklog(resolved, backlog);
  return backlog;
}

export async function saveBacklog(resolved: ResolvedConfig, backlog: Backlog): Promise<void> {
  reconcileIssues(backlog, nowIso());
  const p = backlogPath(resolved);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(backlog, null, 2));
  await rename(tmp, p);
  await writeFile(markdownPath(resolved), renderMarkdown(backlog));
  // The folders are a projection of what was just written, so they are written
  // with it. A save that left them behind would leave `.lookout/issues/` saying
  // something the backlog no longer does.
  await materializeIssues(resolved, backlog);
}

/** What one conformance sweep did, for the run summary. */
export interface ConformanceRun {
  /** Files that came back with a verdict, cache hits included. */
  read: number;
  /** Of those, how many cost nothing because the file had not changed. */
  cached: number;
  /** Files chosen for reading. */
  considered: number;
  /** Files chosen but left without a verdict; asked about again next run. */
  unread: number;
  /** Hand-rolled controls the reader stands behind. */
  found: number;
  /** Scanner suspicions it killed. */
  refuted: number;
  costUsd: number;
}

/** Merge the latest evidence + judge results; shared with `lookout check`. */
export async function mergeLatest(
  resolved: ResolvedConfig,
  opts: {
    judgeOutcome?: CheckOutcome | null;
    /**
     * Also read the source and file hand-rolled duplicates of kit components.
     *
     * Opt-in rather than automatic, because `verify-fix` merges through here
     * too. A visual fix that happens to be verified in a repository with a
     * hand-rolled button would otherwise file that button as an issue the fix
     * had just caused, which is untrue: it was there all along and nobody had
     * looked. `check` is the verb that sweeps, so `check` is the verb that asks.
     */
    scanSource?: boolean;
    /**
     * Also read the application with the conformance skill, which sees the
     * hand-rolls the scan cannot: a control built out of raw elements in a file
     * that imports the kit for something else. Costs model calls, so the caller
     * decides, and the caller is `check`.
     */
    conformance?: { model?: string; fileBudget?: number };
  },
): Promise<{
  backlog: Backlog;
  added: number;
  reopened: number;
  refreshed: number;
  conformance?: ConformanceRun;
}> {
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
  // 2. AI findings from the given or on-disk judge report.
  let judge = opts.judgeOutcome ?? null;
  if (!judge) {
    const jp = join(lookoutDir(resolved), "evidence", "judge-report.json");
    if (existsSync(jp)) judge = JSON.parse(await readFile(jp, "utf8")) as CheckOutcome;
  }
  const shotsById = new Map(report.shots.map((s) => [s.id, s]));
  const ai = judge ? aiToFindings(judge.findings, shotsById) : [];

  // Both channels are stamped with the CAPTURE run id, not the judge's own.
  // `lastSeen` answers one question, asked by `backlog check`: which capture run
  // did this survive? Stamping the AI channel with the judge run id made that
  // unanswerable, because the two id families ("web-…" and "check-…") never
  // match, so every open AI finding the judge had just re-found was reported as
  // drift-resolved and the documented gate failed on healthy backlogs. The judge
  // run id is not lost: it stays on the outcome and in judge-report.json, and
  // each evidence ref already carries the run its shot came from.
  // 3. Source findings: hand-rolled duplicates of components the project's own
  // design system already provides. Read from the repository rather than from
  // any screenshot, which is why they are their own channel.
  let code: ReturnType<typeof deterministicToFindings> = [];
  let conformance: ConformanceRun | undefined;
  if (opts.scanSource) {
    const { resolveInventory } = await import("../design/resolve.js");
    const { primaryKit } = await import("../design/inventory.js");
    const { handRollsToFindings } = await import("../backlog/lib.js");
    const inv = await resolveInventory(resolved, { refresh: true });
    const kit = primaryKit(inv);
    let handRolls = inv.handRolls;

    // The reading pass, when the caller asked for it. It both adds what the
    // scan cannot see and removes what the scan got wrong, so it runs before
    // anything is filed rather than after.
    if (kit && opts.conformance) {
      const { readConformance, mergeHandRolls } = await import("../design/conformance.js");
      const { repoRootOf } = await import("../design/detect.js");
      const read = await readConformance(resolved, inv, await repoRootOf(resolved.projectDir), {
        model: opts.conformance.model,
        fileBudget: opts.conformance.fileBudget,
      });
      handRolls = mergeHandRolls(inv.handRolls, read);
      conformance = {
        read: read.examined.length,
        cached: read.cached,
        considered: read.considered,
        unread: read.unread.length,
        found: read.handRolls.length,
        refuted: read.refuted.length,
        costUsd: read.costUsd,
      };
      emit(
        "note",
        `conformance: read ${read.examined.length} file(s), ${read.handRolls.length} hand-rolled control(s), ` +
          `${read.refuted.length} suspicion(s) refuted`,
        { read: read.examined.length, cached: read.cached, found: read.handRolls.length },
      );
    }

    if (kit && handRolls.length > 0) {
      // A source finding is not about one target, but a finding must name one
      // and the cluster key is built from it. The first configured target is
      // the project's primary by convention, and using it consistently is what
      // keeps a re-found duplicate merging onto the same issue.
      const target = resolved.config.targets[0]?.name ?? "app";
      code = handRollsToFindings(handRolls, kit.name, target);
    }
  }

  const r1 = mergeFindings(backlog, [...det, ...code], latestRun.id, now);
  const r2 = judge
    ? mergeFindings(backlog, ai, latestRun.id, now)
    : { added: [] as string[], reopened: [] as string[], refreshed: [] as string[], suppressed: [] as string[] };

  await saveBacklog(resolved, backlog);
  return {
    backlog,
    added: r1.added.length + r2.added.length,
    reopened: r1.reopened.length + r2.reopened.length,
    refreshed: r1.refreshed.length + r2.refreshed.length,
    ...(conformance ? { conformance } : {}),
  };
}

export async function backlog(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0] ?? "stats";
  const resolved = await loadConfig({ configPath: str(parsed.flags.config), url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]) });

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
    // What is frozen, per issue. Read here rather than inside the checker so
    // that stays a pure function of the backlog, which is what lets the tests
    // hand it one.
    const framesByIssue: Record<string, number> = {};
    for (const id of Object.keys(b.issues ?? {})) {
      framesByIssue[id] = (await loadFrames(resolved, id)).before.length;
    }
    const problems = checkBacklog(b, { mdOnDisk: md, latestReport: report, framesByIssue });
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
    "expected merge | set | reopen | regen | check | stats",
  );
}
