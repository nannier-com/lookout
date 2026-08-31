/**
 * `check --first`: one issue, found as cheaply as it can be, reported as
 * honestly as a full check would.
 *
 * Each route is captured and judged on its own and the walk stops at the
 * first that turns something up. Two rules keep it honest, both learned from
 * the UI's play button, which drives every run through this path:
 *
 * - The stop rule matches the full check's exit standard: STANDING findings,
 *   not merely newly filed ones. A repeat walk over an unchanged app used to
 *   branch on added+reopened, and cache-served findings of open issues come
 *   back as "refreshed", so it walked every route at full capture cost and
 *   printed "no issues found" over a backlog full of open work.
 *
 * - Routes already carrying open findings are walked FIRST, worst severity
 *   first. A repeat run therefore stops at stop one with one route's capture
 *   and zero judge calls, which is where "find me one issue" actually
 *   approaches zero marginal cost. Clean routes are still captured and
 *   cache-judged on the way to a dirty one when the walk gets that far: they
 *   might have regressed, and skipping them would be the false-clean
 *   shortcut this file exists to avoid.
 */
import { resolveTargets } from "../targets.js";
import { issuesOf } from "../issues/registry.js";
import { emit } from "../report/events.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { list, printJson, type Parsed } from "../util.js";
import type { Backlog, BacklogFinding } from "../backlog/lib.js";

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * The walk order: routes with open findings first (worst first, then config
 * order), then the rest in config order. Exported for the tests; pure.
 */
export function orderStops(
  stops: { target: string; route: string }[],
  openFindings: readonly Pick<BacklogFinding, "target" | "route" | "severity" | "status" | "channel">[],
): { target: string; route: string }[] {
  const worst = new Map<string, number>();
  for (const f of openFindings) {
    if (f.status !== "open" || f.channel === "code") continue;
    const key = `${f.target}|${f.route}`;
    const rank = SEVERITY_RANK[f.severity] ?? 4;
    worst.set(key, Math.min(worst.get(key) ?? 5, rank));
  }
  const dirty = stops.filter((s) => worst.has(`${s.target}|${s.route}`));
  dirty.sort((a, b) => worst.get(`${a.target}|${a.route}`)! - worst.get(`${b.target}|${b.route}`)!);
  return [...dirty, ...stops.filter((s) => !worst.has(`${s.target}|${s.route}`))];
}

export async function firstIssue(parsed: Parsed, pre: ResolvedConfig): Promise<number> {
  const { runCheck } = await import("../verbs/check.js");
  const { loadBacklog, mergeLatest } = await import("../verbs/backlog.js");

  const targets = resolveTargets(
    pre.config,
    list(parsed.flags.targets),
    list(parsed.flags.routes),
    pre.configPath,
  );
  const plainStops: { target: string; route: string }[] = [];
  for (const t of targets) for (const r of t.routes) plainStops.push({ target: t.def.name, route: r.path });
  if (plainStops.length === 0) throw new LookoutError("no routes match the given --targets/--routes");

  const priorBacklog: Backlog = await loadBacklog(pre);
  const stops = orderStops(plainStops, Object.values(priorBacklog.findings));

  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string): void => {
    if (!quiet) console.log(line);
  };

  for (const [i, stop] of stops.entries()) {
    emit("phase", `looking at ${stop.target}${stop.route} (${i + 1}/${stops.length})`);
    log(`\n[${i + 1}/${stops.length}] ${stop.target}${stop.route}`);
    // One route at a time, through the ordinary path: same capture, same
    // judge, same rules, just scoped.
    const scoped: Parsed = {
      ...parsed,
      flags: { ...parsed.flags, targets: stop.target, routes: stop.route },
    };
    const { outcome, resolved } = await runCheck(scoped, {});
    // Everything this route turned up is filed. lookout captured and judged it
    // already, so dropping any of it would throw away work it has done and
    // report the route as healthier than it found it.
    //
    // No conformance read here on purpose. `--first` exists to find one issue
    // as cheaply as possible, and a conformance sweep reads the application's
    // source rather than this route, so it would spend the same money on every
    // stop of the walk to answer a question that has nothing to do with which
    // route was captured. A full `check` is where that question is asked.
    const merged = await mergeLatest(resolved, { judgeOutcome: outcome, scanSource: true });

    // Standing findings stop the walk, exactly as they set a full check's
    // exit code. "Already filed" is still a defect on the screen.
    const standing = outcome.findings.length + outcome.deterministicErrors;
    if (standing > 0) {
      const fresh = merged.added + merged.reopened;
      const note =
        `${standing} finding(s) standing on ${stop.target}${stop.route} ` +
        (fresh > 0
          ? `(${merged.added} newly filed, ${merged.reopened} reopened)`
          : "(all already filed)") +
        `, after looking at ${i + 1} of ${stops.length} route(s)`;

      // The issues this route carries get their placement now: the play
      // button loops through here, and an issue born on this path never
      // reached the full check's placement sweep. Bounded to this route.
      if (!parsed.flags["no-placement"]) {
        const { resolveInventory } = await import("../design/resolve.js");
        const { placeNewIssues } = await import("../design/place-issues.js");
        const inv = await resolveInventory(resolved);
        if (inv.kits[0]) {
          const here = issuesOf(merged.backlog, { statuses: ["open"] })
            .filter((c) => c.channel !== "code" && c.routes.includes(stop.route))
            .map((c) => c.id);
          const run = await placeNewIssues(resolved, merged.backlog, inv, { only: here });
          if (run.placed > 0) {
            const { saveBacklog } = await import("../verbs/backlog.js");
            await saveBacklog(resolved, merged.backlog);
          }
        }
      }

      log(`\n${note}`);
      emit("note", note, { route: stop.route, checked: i + 1, of: stops.length, found: standing });
      emit("run-end", note, { findings: standing, costUsd: outcome.costUsd });
      if (parsed.flags.json) printJson({ ...outcome, foundOn: stop.route, checked: i + 1 });
      return 1;
    }
    log(`  nothing on ${stop.route}`);
  }

  // Every route walked and nothing standing on any of them. That is a real
  // result, but it is not "no issues" while the backlog holds open work the
  // walk could not reach (other targets, native platforms, the code channel,
  // or routes outside a scoped walk).
  const openElsewhere = Object.values(priorBacklog.findings).filter(
    (f) => f.status === "open",
  ).length;
  const clean =
    openElsewhere > 0
      ? `nothing newly found across ${stops.length} route(s); the backlog still holds ` +
        `${openElsewhere} open finding(s) this walk could not reach`
      : `no issues found across ${stops.length} route(s)`;
  log(`\n${clean}`);
  emit("run-end", clean, { findings: 0, openElsewhere });
  if (parsed.flags.json) printJson({ findings: [], checked: stops.length, openElsewhere });
  return 0;
}
