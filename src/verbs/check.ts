/**
 * `lookout check`: capture (unless --no-capture) then judge the evidence with
 * the local Claude Code CLI against the base rubric plus the project
 * extension. Ledger-cached per shot hash, adversarially verified for
 * critical/high, written to .lookout/evidence/judge-report.json.
 *
 * Exit 1 when any confirmed AI finding or error-severity deterministic
 * finding stands; 0 when clean.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, evidenceDir } from "../config.js";
import { loadReport } from "../capture/store.js";
import { batchShots, judgeBatch, type AiFinding } from "../judge/engine.js";
import { loadRubric } from "../judge/rubric.js";
import { ledgerKey, loadLedger, recordVerdicts, saveLedger } from "../judge/ledger.js";
import { verifyFindings, type VerifiedFinding } from "../judge/verify.js";
import { LookoutError, type ShotRecord } from "../types.js";
import { list, num, printJson, runId, str, type Parsed } from "../util.js";
import { runCapture } from "./capture.js";

export interface CheckOutcome {
  runId: string;
  model: string;
  rubricVersion: number;
  shotsConsidered: number;
  judged: number;
  cached: number;
  findings: (VerifiedFinding & { cached?: boolean })[];
  refuted: { title: string; shotId: string; verifierNote: string }[];
  rejected: number;
  deterministicErrors: number;
  costUsd: number;
  reportPath: string;
}

export async function runCheck(parsed: Parsed): Promise<{
  outcome: CheckOutcome;
  resolved: Awaited<ReturnType<typeof loadConfig>>;
  shotsById: Map<string, ShotRecord>;
}> {
  // 1. Fresh evidence unless the caller judges an existing set.
  let resolved;
  if (parsed.flags["no-capture"]) {
    resolved = await loadConfig({ configPath: str(parsed.flags.config), url: str(parsed.flags.url) });
  } else {
    resolved = (await runCapture(parsed)).resolved;
  }

  const report = await loadReport(resolved);
  if (!report || report.shots.length === 0) {
    throw new LookoutError(
      "no captured evidence to judge",
      "run `lookout capture` first, or drop --no-capture",
    );
  }

  // 2. Scope selection mirrors capture's flags.
  const onlyTargets = list(parsed.flags.targets);
  const onlyRoutes = list(parsed.flags.routes);
  const shots = report.shots.filter(
    (s) =>
      s.platform === "web" &&
      (!onlyTargets || onlyTargets.includes(s.target)) &&
      (!onlyRoutes ||
        onlyRoutes.some((r) => s.route === r || s.route === `/${r}` || s.routeName === r)),
  );
  if (shots.length === 0) throw new LookoutError("no shots match the given --targets/--routes");
  const shotsById = new Map(shots.map((s) => [s.id, s]));

  // 3. Rubric + cache partition.
  const rubric = await loadRubric(resolved);
  const model = str(parsed.flags.model) ?? "sonnet";
  const ledger = await loadLedger(resolved);
  const toJudge: ShotRecord[] = [];
  const cachedFindings: (VerifiedFinding & { cached: boolean })[] = [];
  let cached = 0;
  for (const s of shots) {
    const entry = ledger.entries[ledgerKey(s.hash, rubric.version, model)];
    if (entry && !s.animated) {
      cached++;
      for (const f of entry.findings ?? []) {
        cachedFindings.push({ ...f, verified: true, cached: true });
      }
    } else {
      toJudge.push(s);
    }
  }

  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string) => {
    if (!quiet) console.log(line);
  };

  // 4. Judge in batches, a couple of subprocesses at a time.
  const evDir = evidenceDir(resolved);
  const batches = batchShots(toJudge, num(parsed.flags["batch-size"]) ?? 10);
  const concurrency = num(parsed.flags.concurrency) ?? 2;
  log(
    `judging ${toJudge.length} shot(s) in ${batches.length} batch(es) with model ${model} ` +
      `(${cached} cached under rubric v${rubric.version})`,
  );

  const fresh: AiFinding[] = [];
  let rejectedCount = 0;
  let costUsd = 0;
  let batchIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = batchIndex++;
      if (i >= batches.length) return;
      const batch = batches[i]!;
      const res = await judgeBatch(rubric.text, resolved.project, batch, evDir, model);
      fresh.push(...res.findings);
      rejectedCount += res.rejected.length;
      costUsd += res.costUsd ?? 0;
      log(
        `  batch ${i + 1}/${batches.length}: ${batch.length} shot(s), ` +
          `${res.findings.length} finding(s)${res.rejected.length ? `, ${res.rejected.length} rejected` : ""}` +
          ` (${(res.durationMs / 1000).toFixed(0)}s)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  // 5. Adversarial verification for critical/high.
  let confirmed: VerifiedFinding[];
  let refuted: (AiFinding & { verifierNote: string })[] = [];
  if (parsed.flags["no-verify"] || fresh.length === 0) {
    confirmed = fresh.map((f) => ({ ...f, verified: false }));
  } else {
    const res = await verifyFindings(fresh, shotsById, evDir, model);
    confirmed = res.confirmed;
    refuted = res.refuted;
    costUsd += res.costUsd ?? 0;
    if (refuted.length > 0) log(`verifier refuted ${refuted.length} finding(s)`);
  }

  // 6. Ledger: judged shots record their post-verification findings.
  const checkRunId = runId("check");
  const perShot = new Map<string, { hash: string; findings: AiFinding[] }>();
  for (const s of toJudge) perShot.set(s.id, { hash: s.hash, findings: [] });
  for (const f of confirmed) perShot.get(f.shotId)?.findings.push(f);
  recordVerdicts(ledger, checkRunId, rubric.version, model, perShot);
  await saveLedger(resolved, ledger);

  const allFindings = [...confirmed, ...cachedFindings];
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  allFindings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const deterministicErrors = shots
    .flatMap((s) => s.deterministicFindings)
    .filter((f) => f.severity === "error").length;

  const reportPath = join(evDir, "judge-report.json");
  const outcome: CheckOutcome = {
    runId: checkRunId,
    model,
    rubricVersion: rubric.version,
    shotsConsidered: shots.length,
    judged: toJudge.length,
    cached,
    findings: allFindings,
    refuted: refuted.map((r) => ({ title: r.title, shotId: r.shotId, verifierNote: r.verifierNote })),
    rejected: rejectedCount,
    deterministicErrors,
    costUsd: Number(costUsd.toFixed(4)),
    reportPath,
  };
  await writeFile(reportPath, JSON.stringify(outcome, null, 2));
  return { outcome, resolved, shotsById };
}

export async function check(parsed: Parsed): Promise<number> {
  const { outcome, resolved, shotsById } = await runCheck(parsed);

  // Projects with a config file track findings in the backlog automatically;
  // zero-config runs stay report-only (a backlog in a random cwd is noise).
  let backlogNote = "";
  if (resolved.configPath) {
    const { mergeLatest } = await import("./backlog.js");
    const merged = await mergeLatest(resolved, { judgeOutcome: outcome });
    backlogNote = `backlog: ${merged.added} added, ${merged.reopened} reopened, ${merged.refreshed} refreshed`;
  }

  if (parsed.flags.json) {
    printJson(outcome);
  } else {
    console.log(
      `\n${outcome.shotsConsidered} shot(s): ${outcome.judged} judged, ${outcome.cached} cached; ` +
        `${outcome.findings.length} finding(s), ${outcome.refuted.length} refuted; ` +
        `${outcome.deterministicErrors} deterministic error(s); ~$${outcome.costUsd}`,
    );
    for (const f of outcome.findings) {
      const shot = shotsById.get(f.shotId);
      console.log(
        `  [${f.severity}] ${f.category}/${f.attribute} ${f.title}` +
          `\n    shot: ${f.shotId}${f.cached ? " (cached)" : ""}${f.verified ? " (verified)" : ""}` +
          (shot ? `\n    evidence: .lookout/evidence/${shot.path}` : ""),
      );
    }
    console.log(`\nreport: ${outcome.reportPath}`);
    if (backlogNote) console.log(backlogNote);
  }
  return outcome.findings.length > 0 || outcome.deterministicErrors > 0 ? 1 : 0;
}
