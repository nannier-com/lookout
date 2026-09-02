/**
 * `lookout check`: capture the app, judge the evidence, write down what stands.
 *
 * The verb is four steps, and each of them lives in its own module under
 * `src/check` because each answers a different question: what are we looking at
 * (`scope`), what still needs judging and by which rules (`plan`), what does
 * the judge say once the refuter has been at it (`batches`), and what does the
 * run leave behind (`outcome`). What is left here is the order they run in, and
 * the two things a caller does with the result: exit on it, or stop at the
 * first issue and hand it over.
 *
 * A batch that fails does not fail the run: it is recorded, left out of the
 * cache so it is judged again next time, and the rest of the run stands. Only a
 * run where every batch failed is an error, because that one judged nothing.
 *
 * Exit 1 when any confirmed AI finding or error-severity deterministic finding
 * stands; 0 when clean.
 */
import { join } from "node:path";
import { evidenceDir, loadConfig } from "../config.js";
import { judgeInBatches, type RunCheckOptions } from "../check/batches.js";
import { reverifyCached } from "../check/reverify.js";
import { recordOutcome, type CheckOutcome } from "../check/outcome.js";
import { planJudging } from "../check/plan.js";
import { maybeRefreshNavigation } from "../check/navigate.js";
import { resolveScope } from "../check/scope.js";
import { tallyLines } from "../check/tally.js";
import { SEVERITIES } from "../judge/rubric.js";
import { emit, EventLog, setCurrentLog } from "../report/events.js";
import { Narration, setCurrentNarration } from "../report/narration.js";
import { sheetNote } from "../capture/sheet.js";
import { runContactSheet } from "./capture.js";
import { LookoutError, type ResolvedConfig, type Severity, type ShotRecord } from "../types.js";
import { num, printJson, runId, str, type Parsed } from "../util.js";

export type { CheckOutcome, RunCheckOptions };

// Lives with the verdict rule now; re-exported so existing importers keep working.
export { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";

/**
 * One check, start to finish.
 *
 * Returns more than the outcome because two callers need the middle of it:
 * `verify-fix` re-judges a known set of shots, and the ui narrates them.
 */
export async function runCheck(
  parsed: Parsed,
  opts: RunCheckOptions = {},
): Promise<{
  outcome: CheckOutcome;
  resolved: ResolvedConfig;
  shotsById: Map<string, ShotRecord>;
  toJudge: ShotRecord[];
}> {
  const scope = await resolveScope(parsed);

  // --json and --quiet both mean the caller is reading the result, not the
  // narration. The event log is written either way.
  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string): void => {
    if (!quiet) console.log(line);
  };

  // Navigation discovery's model spend happens here, before judging plans
  // are drawn up: stale routes get fresh interaction plans, their states are
  // captured, and the new shots join the scope the panels will see.
  const nav = await maybeRefreshNavigation({ scope, parsed, log });

  const plan = await planJudging(scope.resolved, scope.shots, parsed);

  // Refute-on-read before the fresh batches: cached groups holding findings
  // the refuter never saw (a --no-verify run, a refuter that failed) get the
  // adversarial pass now, capped, and the ledger entry is repaired in place.
  const repairs = await reverifyCached({
    resolved: scope.resolved,
    plan,
    shotsById: scope.shotsById,
    parsed,
    log,
  });

  const pass = await judgeInBatches({
    resolved: scope.resolved,
    plan,
    shotsById: scope.shotsById,
    parsed,
    log,
    opts,
  });
  pass.refuted.push(...repairs.refuted);
  pass.costUsd += repairs.costUsd + nav.costUsd;
  const outcome = await recordOutcome({
    resolved: scope.resolved,
    scope,
    plan,
    pass,
    log,
    fullScope: !parsed.flags.targets && !parsed.flags.routes,
  });
  return { outcome, resolved: scope.resolved, shotsById: scope.shotsById, toJudge: plan.toJudgeShots };
}

/** The worst-acceptable severity a caller cares about; critical and high by default. */
export function autoSeverity(parsed: Parsed): Severity {
  const raw = str(parsed.flags.severity);
  if (!raw) return "high";
  if (!(SEVERITIES as readonly string[]).includes(raw)) {
    throw new LookoutError(
      `unknown --severity "${raw}"`,
      `one of: ${SEVERITIES.join(", ")}`,
    );
  }
  return raw as Severity;
}

export async function check(parsed: Parsed): Promise<number> {
  const checkRun = runId("check");

  // Narrate to disk from the first moment. A run takes minutes and its stdout
  // does not reach the caller until it exits, so `lookout status` and `lookout
  // ui` read this instead, while the run is still going.
  const pre = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
  });
  const elog = new EventLog(pre, checkRun);
  elog.start("lookout check", {
    project: pre.project,
    targets: str(parsed.flags.targets) ?? null,
    routes: str(parsed.flags.routes) ?? null,
  });
  setCurrentLog(elog);
  // What the judges say while they say it. Its own file beside the event log,
  // because it is a tail nothing is reconstructed from and it is written a
  // hundred times more often.
  const narration = new Narration(pre, checkRun);
  narration.start();
  setCurrentNarration(narration);

  // Asked for one issue? Then walk the application one route at a time and
  // stop the moment something is found. Capturing all thirteen routes across
  // every form factor and scheme before judging anything is exactly what "find
  // me one issue" is asking you not to do: it is seventy-odd screenshots and
  // several minutes to answer a question that the first route usually settles.
  if (parsed.flags.first && pre.configPath) {
    const { firstIssue } = await import("../check/first.js");
    const code = await firstIssue(parsed, pre);
    setCurrentLog(null);
    setCurrentNarration(null);
    return code;
  }

  const { outcome, resolved, shotsById } = await runCheck(parsed, {});

  // Projects with a config file track findings in the backlog automatically;
  // zero-config runs stay report-only (a backlog in a random cwd is noise).
  let backlogNote = "";
  if (resolved.configPath) {
    const { mergeLatest, saveBacklog } = await import("./backlog.js");
    // Reading the application for hand-rolled controls, which is the half of
    // the code channel no screenshot and no regex can reach. On by default,
    // capped, and switched off with --no-conformance: a run that spends money
    // with no way to say no is a run people stop making. Unchanged files are
    // carried from the cache, so the cost falls to nearly nothing on a repeat.
    // The reading pass runs on FULL-scope checks. It reads the application's
    // source, not the captured routes, so a scoped run would pay the same
    // sweep on every iteration of a tight fix loop to answer a question that
    // has nothing to do with which route was captured; the same reasoning
    // --first has always carried. An explicit --max-conformance is explicit
    // consent and overrides. The skip is reported, never silent.
    const routeScoped = !!(parsed.flags.targets || parsed.flags.routes);
    const conformanceOn =
      !parsed.flags["no-conformance"] &&
      (!routeScoped || parsed.flags["max-conformance"] !== undefined);
    const merged = await mergeLatest(resolved, {
      judgeOutcome: outcome,
      scanSource: true,
      ...(conformanceOn
        ? {
            conformance: {
              model: str(parsed.flags.model),
              fileBudget: num(parsed.flags["max-conformance"]),
              cache: !parsed.flags["no-cache"],
            },
          }
        : {}),
    });
    backlogNote = `backlog: ${merged.added} added, ${merged.reopened} reopened, ${merged.refreshed} refreshed`;
    if (!conformanceOn && !parsed.flags["no-conformance"]) {
      backlogNote += "; conformance: skipped (scoped run; a full check sweeps the source)";
    }
    if (merged.conformance) {
      const c = merged.conformance;
      backlogNote +=
        `; conformance: ${c.read} of ${c.considered} file(s) read (${c.cached} cached), ` +
        `${c.found} hand-rolled control(s), ${c.refuted} suspicion(s) refuted` +
        (c.disagreements > 0
          ? `, reader disagrees with ${c.disagreements} open finding(s) (see the notes)`
          : "") +
        (c.unread > 0 ? `, ${c.unread} not read` : "");
    }

    // Where each new issue belongs, in a project that has a design system. A
    // defect is found on a screen and fixed in a component, and those are
    // rarely the same file, so the issue document says which before anybody
    // opens it. Once per issue, ever: it is a fact about the codebase.
    // Placement costs a model call per newly filed issue, so it has an off
    // switch and a cap. Neither is a default anybody should have to reach for,
    // but a first sweep of a neglected project can file a lot at once, and a
    // tool that spends money with no way to say no is one people stop running.
    if (!parsed.flags["no-placement"]) {
      const { resolveInventory } = await import("../design/resolve.js");
      const { placeNewIssues } = await import("../design/place-issues.js");
      const inv = await resolveInventory(resolved);
      const kit = inv.kits[0];
      if (kit) {
        const run = await placeNewIssues(resolved, merged.backlog, inv, {
          model: str(parsed.flags.model),
          limit: num(parsed.flags["max-placements"]),
        });
        if (run.placed > 0) await saveBacklog(resolved, merged.backlog);
        // Every slot the sweep consumed is said out loud. An all-fail run
        // used to print nothing at all, and a cap of zero promised leftovers
        // "for the next run" that the cap guaranteed would never come.
        if (run.limit === 0 && run.skipped > 0) {
          backlogNote += `; placement: off (cap 0); ${run.skipped} issue(s) unplaced`;
        } else if (run.placed + run.failed + run.skipped > 0 || run.costUsd > 0) {
          backlogNote +=
            `; placement: ${run.placed} issue(s) located in ${kit.name}` +
            (run.failed > 0 ? `, ${run.failed} failed` : "") +
            (run.skipped > 0 ? `, ${run.skipped} beyond this run's cap` : "") +
            (run.costUsd > 0 ? ` (~$${run.costUsd.toFixed(4)})` : "");
        }
      }
    }
  }

  // The learning loop's trigger: enough new evidence, and this run ends by
  // improving the skills that produced it. Spend is visible (narrated, in
  // the payload under --json), capped by the cooldown, and declinable.
  let learned: import("../skills/auto-improve.js").AutoImproveResult | null = null;
  if (resolved.configPath) {
    const { maybeAutoImprove } = await import("../skills/auto-improve.js");
    learned = await maybeAutoImprove(resolved, parsed, (line) => {
      if (!parsed.flags.json && !parsed.flags.quiet) console.log(line);
    });
  }

  // One image showing everything judged, with the tiles that carry findings
  // marked. A session driving lookout should be able to see what lookout saw
  // without spending more of its context on screenshots than on the findings.
  const findingsByShot = new Map<string, number>();
  for (const f of outcome.findings) {
    findingsByShot.set(f.shotId, (findingsByShot.get(f.shotId) ?? 0) + 1);
  }
  const sheet = await runContactSheet(resolved, [...shotsById.values()], findingsByShot);
  outcome.contactSheet = sheet?.path ?? null;

  // One line about lookout itself, when its own failures are recurring here:
  // a cheap file read, an ignorable sentence, and the only place a project run
  // mentions the incident log at all.
  if (!parsed.flags.json && !parsed.flags.quiet) {
    const { activeGroups, readHeals } = await import("../skills/heal-select.js");
    const { readIncidents } = await import("../skills/incidents.js");
    const { ownCheckout } = await import("../checkout.js");
    const hot = activeGroups(readIncidents(resolved.projectDir), readHeals(ownCheckout())).filter(
      (g) => g.recurred || g.count >= 3,
    );
    if (hot.length > 0) {
      console.log(
        `\nlookout itself: ${hot.length} recurring failure(s) in this project; ` +
          "`lookout self-heal` reads the log (manual)",
      );
    }
  }

  if (parsed.flags.json) {
    printJson({ ...outcome, ...(learned ? { learned } : {}) });
  } else {
    console.log(
      `\n${outcome.shotsConsidered} shot(s): ${outcome.judged} judged, ${outcome.cached} cached` +
        // Said out loud, because a shot nobody ruled on is not a clean shot and
        // the difference is invisible in a finding count.
        (outcome.unjudged > 0 ? `, ${outcome.unjudged} NOT judged` : "") +
        `; ${outcome.findings.length} finding(s), ${outcome.refuted.length} refuted; ` +
        `${outcome.deterministicErrors} deterministic error(s); ~$${outcome.costUsd}`,
    );
    // Per form factor, because "12 judged" says nothing about whether the
    // phone shots were among them, and a form factor nobody ruled on is the
    // one number here that changes what the reader does next.
    for (const line of tallyLines(outcome.formFactors)) console.log(`  ${line}`);
    for (const f of outcome.findings) {
      const shot = shotsById.get(f.shotId);
      console.log(
        `  [${f.severity}] ${f.category}/${f.attribute} ${f.title}` +
          `\n    shot: ${f.shotId}${f.cached ? " (cached)" : ""}${f.verified ? " (verified)" : ""}` +
          (shot ? `\n    evidence: ${join(evidenceDir(resolved), shot.path)}` : ""),
      );
    }
    console.log(`\nreport: ${outcome.reportPath}`);
    if (backlogNote) console.log(backlogNote);
    if (sheet) console.log(`\n${sheetNote(sheet)}`);
  }
  emit("run-end", `${outcome.findings.length} finding(s); ~$${outcome.costUsd}`, {
    findings: outcome.findings.length,
    costUsd: outcome.costUsd,
  });
  setCurrentLog(null);
  setCurrentNarration(null);
  return outcome.findings.length > 0 || outcome.deterministicErrors > 0 ? 1 : 0;
}
