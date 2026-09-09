/**
 * One step of `check`: refresh stale navigation plans, then re-capture the
 * routes whose plans changed so their synthesized states join this run's
 * scope.
 *
 * Who gets to plan: a run that sees the config's whole intent. That is a
 * full-scope check, or a `--first` walk, which sees the same intent one route
 * at a time. The walk had to be named here because it reaches this module
 * wearing a scoped run's clothes: it synthesizes --targets/--routes for every
 * stop, so the old full-scope-only gate turned discovery off for the ui's play
 * button, which runs `check --first` and had therefore never planned a single
 * call to action. `--navigate` is the third way in, the explicit consent that
 * also overrides signature freshness.
 *
 * A scoped run that does get in plans the routes in its scope and nothing
 * else. Without that narrowing the step would re-plan and re-capture the whole
 * application from inside one stop of a walk, which is the opposite of what
 * the walk is for. `verify-fix` is scoped and never sets `first`, so a fix
 * ruling still spends nothing here and rules on the plan that already exists.
 *
 * Plain `capture` never lands here: the model is only ever spent by `check`.
 */
import { loadReport } from "../capture/store.js";
import { resolveTargets, shotInConfig } from "../targets.js";
import { planRoute } from "../navigate/plan.js";
import { loadSkill } from "../skills/load.js";
import { loadHarvests, loadPlans, plannedStateIndex, savePlans } from "../navigate/store.js";
import { navigationOn } from "../navigate/consent.js";
import { mappedIndex } from "../map/scope.js";
import { list, str, type Parsed } from "../util.js";
import type { CheckScope } from "./scope.js";

/** Plan calls one run may spend; the rest is reported, the placement idiom. */
const MAX_PLAN_CALLS = 10;

export async function maybeRefreshNavigation(args: {
  scope: CheckScope;
  parsed: Parsed;
  log: (line: string) => void;
  /** Test seam; the default re-runs a scoped capture through runCapture. */
  recapture?: (targets: string[], routes: string[]) => Promise<void>;
}): Promise<{ costUsd: number; refreshed: number }> {
  const { scope, parsed, log } = args;
  const config = scope.resolved.config;
  const fullScope = !parsed.flags.targets && !parsed.flags.routes;
  // A stop on the `--first` walk: scoped by the walk, not by the caller.
  const walk = !!parsed.flags.first;
  const force = !!parsed.flags.navigate;
  if (!navigationOn(config, parsed.flags) || (!fullScope && !walk && !force)) {
    return { costUsd: 0, refreshed: 0 };
  }

  const harvests = await loadHarvests(scope.resolved);
  const plans = await loadPlans(scope.resolved);
  const targets = resolveTargets(config, undefined, undefined, scope.resolved.configPath);

  // Stale = the route's affordances changed since it was planned (or it was
  // never planned). --navigate re-plans even fresh routes.
  const onlyTargets = list(parsed.flags.targets);
  const onlyRoutes = list(parsed.flags.routes);
  // What the shipped planner is at right now: a cached plan made by an older
  // one predates whatever it has since learned to look for.
  const plannerVersion = (await loadSkill(scope.resolved, "plan-navigation")).version;
  const stale: { key: string; targetName: string; routePath: string }[] = [];
  for (const [key, harvest] of Object.entries(harvests.routes)) {
    const [targetName, routePath] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    const target = targets.find((t) => t.def.name === targetName);
    const route = target?.routes.find((r) => r.path === routePath);
    if (!target || !route || route.navigation === false) continue;
    // A scoped run plans what it is looking at and leaves the rest alone: one
    // stop of a walk must not re-plan and re-capture the whole application.
    // The spellings are the ones --routes accepts elsewhere: the path, the
    // path without its leading slash, or the route's name.
    if (onlyTargets && !onlyTargets.includes(targetName)) continue;
    if (onlyRoutes && !onlyRoutes.some((r) => r === routePath || `/${r}` === routePath || r === route.name)) {
      continue;
    }
    // A planner that has learned a new kind of state must be asked again, or a
    // project whose controls have not changed never receives one.
    const planned = plans.routes[key];
    if (force || planned?.signature !== harvest.signature || (planned.skillVersion ?? 0) < plannerVersion) {
      stale.push({ key, targetName, routePath: routePath! });
    }
  }
  if (stale.length === 0) return { costUsd: 0, refreshed: 0 };

  const capped = stale.slice(0, MAX_PLAN_CALLS);
  if (stale.length > capped.length) {
    log(`navigation: ${stale.length - capped.length} stale route(s) beyond this run's cap of ${MAX_PLAN_CALLS}`);
  }

  let costUsd = 0;
  const suggestions = new Map<string, string>();
  for (const { key, targetName, routePath } of capped) {
    const target = targets.find((t) => t.def.name === targetName)!;
    const route = target.routes.find((r) => r.path === routePath)!;
    const configuredPaths = target.routes.map((r) => r.path);
    const restShots = scope.shots.filter(
      (s) => s.target === targetName && s.route === routePath && s.state === "rest",
    );
    const res = await planRoute({
      resolved: scope.resolved,
      target: targetName,
      route: routePath,
      harvest: harvests.routes[key]!,
      restShots,
      recipeNames: route.states,
      configuredPaths,
      // Defaults when the flag turned discovery on and the config carries no
      // block of its own, the same fallback capture's executor already uses.
      navigation: config.navigation ?? {},
      model: str(parsed.flags.model),
    });
    costUsd += res.costUsd;
    for (const note of res.notes) log(`navigation (${targetName}${routePath}): ${note}`);
    if (res.plan) {
      plans.routes[key] = res.plan;
      for (const s of res.plan.suggestions) suggestions.set(s.path, s.label);
    }
  }
  await savePlans(scope.resolved, plans);
  log(`navigation: re-planned ${capped.length} route(s)${costUsd ? ` (~$${costUsd.toFixed(2)})` : ""}`);
  if (suggestions.size > 0) {
    const listed = [...suggestions].map(([p, l]) => `${p} (${l})`).join(", ");
    log(`navigation: discovered unconfigured route(s): ${listed}; add them to lookout.config.ts to judge them at rest`);
  }

  // Execute the new plans now, scoped to the affected routes, so this run
  // judges what it just planned. A scoped capture never prunes, and re-shot
  // rest frames keep their hashes, so cached panel verdicts survive.
  const recapture =
    args.recapture ??
    (async (targetNames: string[], routePaths: string[]) => {
      const { runCapture } = await import("../verbs/capture.js");
      await runCapture({
        ...parsed,
        flags: { ...parsed.flags, targets: targetNames.join(","), routes: routePaths.join(",") },
      });
    });
  await recapture(
    [...new Set(capped.map((s) => s.targetName))],
    [...new Set(capped.map((s) => s.routePath))],
  );

  // Fold the fresh shots (synthesized states included) back into scope.
  const report = await loadReport(scope.resolved);
  if (report) {
    const planned = await plannedStateIndex(scope.resolved);
    const mapped = await mappedIndex(scope.resolved);
    scope.shots = report.shots.filter(
      (s) =>
        s.platform === "web" &&
        shotInConfig(s, targets, planned, mapped) &&
        (!onlyTargets || onlyTargets.includes(s.target)) &&
        (!onlyRoutes || onlyRoutes.some((r) => s.route === r || s.route === `/${r}` || s.routeName === r)),
    );
    scope.shotsById = new Map(scope.shots.map((s) => [s.id, s]));
  }
  return { costUsd, refreshed: capped.length };
}
