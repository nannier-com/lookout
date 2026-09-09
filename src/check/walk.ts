/**
 * `check` over a screen map: one screen at a time. Reach it (replay, else a
 * navigator), judge exactly the shots that reach produced, write the ledger
 * and the report, file the findings, then the next screen. Under `--first`
 * the walk stops at the first screen with standing findings, exactly as the
 * route walk does; without it, every screen is walked and the run ends the
 * way a full check ends.
 *
 * What is never done here: judging a screen that was not reached (it is
 * recorded as unreachable, never as clean), caching a verdict for one, or
 * counting a screen the caps cut as looked at.
 */
import { loadConfig } from "../config.js";
import { pruneLedger, saveLedger } from "../judge/ledger.js";
import { preflightRun } from "../capture/run-preflight.js";
import { configuredScope } from "../config-scope.js";
import { loadReport } from "../capture/store.js";
import { emit } from "../report/events.js";
import { runContactSheet } from "../verbs/capture.js";
import { LookoutError, type ResolvedConfig, type ShotRecord } from "../types.js";
import { list, printJson, type Parsed } from "../util.js";
import { liveGroupHashes, writeReport, type RunCheckOptions } from "./outcome.js";
import { loadJudging } from "./plan-load.js";
import { MAX_REVERIFY_GROUPS } from "./reverify.js";
import { walkCaps } from "./walk-flags.js";
import type { WalkPlan } from "./walk-gate.js";
import { orderScreens } from "./walk-order.js";
import { reachContext, reachStop } from "./walk-reach.js";
import { accumulate, emptyWalkOutcome, unreached, walkLines, type WalkOutcome } from "./walk-report.js";
import { judgeStop, mergeStop } from "./walk-stop.js";

export async function walkMap(parsed: Parsed, pre: ResolvedConfig, plan: WalkPlan, runId: string, opts: RunCheckOptions = {}): Promise<number> {
  const caps = walkCaps(parsed);
  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string): void => {
    if (!quiet) console.log(line);
  };
  const resolved = await loadConfig({ configPath: pre.configPath ?? undefined });
  const pf = await preflightRun(parsed, resolved);
  const { loadBacklog } = await import("../verbs/backlog.js");
  const prior = await loadBacklog(pre);
  const { stops, skipped } = orderScreens(plan.map, Object.values(prior.findings), {
    targets: list(parsed.flags.targets),
    routes: list(parsed.flags.routes),
    screens: caps.screens,
    platforms: pf.platforms,
  });
  const loaded = await loadJudging(resolved, parsed);
  const ctx = reachContext({ resolved, pf, parsed, runId, caps });
  const mapBuiltAt = Object.values(plan.map.targets).map((t) => t.mappedAt).sort().at(-1) ?? "";
  let outcome = emptyWalkOutcome(loaded, resolved, runId, stops.length, mapBuiltAt);
  const allShots: ShotRecord[] = [];
  const judgedIds = new Set<string>();
  const budget = { navigatorCalls: 0 };
  let reverifyLeft = MAX_REVERIFY_GROUPS;
  let merged = { added: 0, reopened: 0, refreshed: 0, placed: 0 };
  let firstMerge = true;

  log(`walking ${stops.length} screen(s) from the map` + (skipped.length > 0 ? ` (${skipped.length} skipped: ${skipped.map((s) => `${s.id} ${s.reason}`).join("; ")})` : ""));
  emit("phase", `walking ${stops.length} screen(s) from the map`, { screens: stops.length, mapBuiltAt, skipped: skipped.length });

  let cut: "cap" | "budget" | null = null;
  for (const [i, stop] of stops.entries()) {
    if (cut === null && caps.maxScreens !== null && i >= caps.maxScreens) cut = "cap";
    if (cut === null && caps.budgetUsd !== null && outcome.costUsd > caps.budgetUsd) cut = "budget";
    if (cut) {
      const reason = cut === "cap" ? `beyond --max-screens ${caps.maxScreens}` : `budget of $${caps.budgetUsd} exceeded`;
      emit("note", `screen ${stop.id} not walked: ${reason}`, { screen: stop.id, notWalked: cut });
      outcome = unreached(outcome, stop, i, "not-walked", { reason });
      continue;
    }
    log(`\n[${i + 1}/${stops.length}] ${stop.id}`);
    emit("phase", `screen ${stop.id} (${i + 1}/${stops.length}): reaching`, { screen: stop.id, index: i + 1, total: stops.length, route: stop.route, state: stop.state });
    const reach = await reachStop(stop, ctx, plan.seams, caps, budget);
    if (!reach.ok) {
      log(`  unreachable: ${reach.reason}`);
      emit("note", `screen ${stop.id} unreachable: ${reach.reason}`, {
        screen: stop.id, target: stop.target, route: stop.route, state: stop.state, reason: reach.reason, lastLook: reach.lastLook ?? null, unreachable: true, navigatorCalls: reach.navigatorCalls,
      });
      outcome = unreached(outcome, stop, i, "unreachable", reach);
      await writeReport(outcome);
      continue;
    }
    allShots.push(...reach.shots);
    emit("phase", `screen ${stop.id} (${i + 1}/${stops.length}): judging`, { screen: stop.id, index: i + 1, total: stops.length });
    const judged = await judgeStop({ resolved, loaded, shots: reach.shots, parsed, log, opts, runId, reverifyLeft });
    reverifyLeft = Math.max(0, reverifyLeft - judged.reverified);
    for (const s of judged.plan.toJudgeShots) judgedIds.add(s.id);
    outcome = accumulate(outcome, stop, i, reach, judged, allShots, judgedIds);
    await writeReport(outcome);

    emit("phase", `screen ${stop.id} (${i + 1}/${stops.length}): merging`, { screen: stop.id, index: i + 1, total: stops.length });
    const standing = judged.outcome.findings.length + judged.outcome.deterministicErrors;
    const m = await mergeStop(resolved, stop, judged.outcome, parsed, { scanSource: firstMerge, place: caps.first && standing > 0 });
    firstMerge = false;
    merged = { added: merged.added + m.added, reopened: merged.reopened + m.reopened, refreshed: merged.refreshed + m.refreshed, placed: merged.placed + m.placed };
    log(`  ${reach.how}: ${reach.shots.length} shot(s); ${judged.outcome.judged} judged, ${judged.outcome.cached} cached; ${standing} standing`);

    if (caps.first && standing > 0) {
      const fresh = m.added + m.reopened;
      const note =
        `${standing} finding(s) standing on ${stop.id} ` +
        (fresh > 0 ? `(${m.added} newly filed, ${m.reopened} reopened)` : "(all already filed)") +
        `, after looking at ${i + 1} of ${stops.length} screen(s)`;
      log(`\n${note}`);
      emit("note", note, { route: stop.route, screen: stop.id, state: stop.state, checked: i + 1, of: stops.length, found: standing, unit: "screen" });
      emit("run-end", note, { findings: standing, costUsd: outcome.costUsd, screens: { walked: outcome.screens.walked, unreachable: outcome.screens.unreachable, notWalked: 0 } });
      if (parsed.flags.json) printJson({ ...outcome, foundOn: stop.route, foundScreen: stop.id, checked: i + 1, of: stops.length });
      return 1;
    }
  }

  const attempted = outcome.stops.filter((s) => s.status !== "not-walked");
  if (attempted.length > 0 && attempted.every((s) => s.status === "unreachable")) {
    throw new LookoutError(`no screen could be reached (${attempted.length} tried)`, attempted[0]!.reason);
  }
  if (attempted.length > 0 && attempted.every((s) => s.status === "unjudged" || s.status === "unreachable") && outcome.failedBatches.length > 0) {
    throw new LookoutError(`every judge batch failed (${outcome.failedBatches.length})`, outcome.failedBatches[0]!.message);
  }
  if (caps.first) {
    const openElsewhere = Object.values(prior.findings).filter((f) => f.status === "open").length;
    const clean =
      openElsewhere > 0
        ? `nothing newly found across ${outcome.screens.walked} screen(s); the backlog still holds ${openElsewhere} open finding(s) this walk could not reach`
        : `no issues found across ${outcome.screens.walked} screen(s)`;
    log(`\n${clean}`);
    emit("run-end", clean, { findings: 0, openElsewhere, costUsd: outcome.costUsd });
    if (parsed.flags.json) printJson({ ...outcome, checked: outcome.screens.walked, openElsewhere });
    return 0;
  }
  return finish(parsed, resolved, outcome, allShots, merged, loaded.ledger, cut === null && !parsed.flags.targets && !parsed.flags.routes && !caps.screens, log);
}

/** The end of a full walk: the source read once, the placement sweep, the ledger prune, the sheet, the summary. */
async function finish(
  parsed: Parsed,
  resolved: ResolvedConfig,
  outcome: WalkOutcome,
  allShots: ShotRecord[],
  merged: { added: number; reopened: number; refreshed: number; placed: number },
  ledger: Awaited<ReturnType<typeof loadJudging>>["ledger"],
  fullScope: boolean,
  log: (line: string) => void,
): Promise<number> {
  const { mergeLatest, saveBacklog } = await import("../verbs/backlog.js");
  const { str, num } = await import("../util.js");
  let backlogNote = `backlog: ${merged.added} added, ${merged.reopened} reopened, ${merged.refreshed} refreshed`;
  const conformanceOn = !parsed.flags["no-conformance"] && (fullScope || parsed.flags["max-conformance"] !== undefined);
  const final = await mergeLatest(resolved, {
    judgeOutcome: outcome,
    scanSource: true,
    ...(conformanceOn ? { conformance: { model: str(parsed.flags.model), fileBudget: num(parsed.flags["max-conformance"]), cache: !parsed.flags["no-cache"] } } : {}),
  });
  if (!conformanceOn && !parsed.flags["no-conformance"]) backlogNote += "; conformance: skipped (scoped walk; a full walk sweeps the source)";
  if (final.conformance) {
    const c = final.conformance;
    backlogNote += `; conformance: ${c.read} of ${c.considered} file(s) read (${c.cached} cached), ${c.found} hand-rolled control(s), ${c.refuted} suspicion(s) refuted`;
  }
  if (!parsed.flags["no-placement"]) {
    const { resolveInventory } = await import("../design/resolve.js");
    const { placeNewIssues } = await import("../design/place-issues.js");
    const inv = await resolveInventory(resolved);
    if (inv.kits[0]) {
      const run = await placeNewIssues(resolved, final.backlog, inv, { model: str(parsed.flags.model), limit: num(parsed.flags["max-placements"]) });
      if (run.placed > 0) await saveBacklog(resolved, final.backlog);
      if (run.placed + run.failed + run.skipped > 0) backlogNote += `; placement: ${run.placed} issue(s) located in ${inv.kits[0].name}` + (run.skipped > 0 ? `, ${run.skipped} beyond this run's cap` : "");
    }
  }
  if (fullScope) {
    const report = await loadReport(resolved);
    const inScope = await configuredScope(resolved);
    const dropped = pruneLedger(ledger, liveGroupHashes((report?.shots ?? []).filter(inScope)));
    if (dropped > 0) log(`ledger: pruned ${dropped} unreachable cached verdict(s)`);
    await saveLedger(resolved, ledger);
  }
  const { maybeAutoImprove } = await import("../skills/auto-improve.js");
  const learned = await maybeAutoImprove(resolved, parsed, log);
  const findingsByShot = new Map<string, number>();
  for (const f of outcome.findings) findingsByShot.set(f.shotId, (findingsByShot.get(f.shotId) ?? 0) + 1);
  const sheet = await runContactSheet(resolved, allShots, findingsByShot);
  outcome.contactSheet = sheet?.path ?? null;
  await writeReport(outcome);

  if (parsed.flags.json) {
    printJson({ ...outcome, ...(learned ? { learned } : {}) });
  } else {
    const { evidenceDir } = await import("../config.js");
    console.log("");
    for (const line of walkLines(outcome, new Map(allShots.map((s) => [s.id, s])), evidenceDir(resolved))) console.log(line);
    console.log(`\nreport: ${outcome.reportPath}`);
    console.log(backlogNote);
    if (sheet) console.log(`\ncontact sheet: ${sheet.path}`);
  }
  emit("run-end", `${outcome.findings.length} finding(s); ~$${outcome.costUsd}`, {
    findings: outcome.findings.length,
    costUsd: outcome.costUsd,
    screens: { walked: outcome.screens.walked, unreachable: outcome.screens.unreachable, notWalked: outcome.screens.notWalked },
  });
  return outcome.findings.length > 0 || outcome.deterministicErrors > 0 ? 1 : 0;
}
