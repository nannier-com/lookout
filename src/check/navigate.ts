/**
 * One step of `check`: refresh stale navigation plans, then re-capture the
 * routes whose plans changed so their synthesized states join this run's
 * scope.
 *
 * Gated like kit-conformance: full-scope runs only, because a scoped run
 * cannot see the config's whole intent, and `--navigate` is the explicit
 * consent that overrides both the gate and signature freshness. Plain
 * `capture` never lands here: the model is only ever spent by `check`.
 */
import { loadReport } from "../capture/store.js";
import { resolveTargets, shotInConfig } from "../targets.js";
import { planRoute } from "../navigate/plan.js";
import { loadHarvests, loadPlans, plannedStateIndex, savePlans } from "../navigate/store.js";
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
  const force = !!parsed.flags.navigate;
  if (!config.navigation?.enabled || parsed.flags["no-navigation"] || (!fullScope && !force)) {
    return { costUsd: 0, refreshed: 0 };
  }

  const harvests = await loadHarvests(scope.resolved);
  const plans = await loadPlans(scope.resolved);
  const targets = resolveTargets(config, undefined, undefined, scope.resolved.configPath);

  // Stale = the route's affordances changed since it was planned (or it was
  // never planned). --navigate re-plans even fresh routes.
  const stale: { key: string; targetName: string; routePath: string }[] = [];
  for (const [key, harvest] of Object.entries(harvests.routes)) {
    const [targetName, routePath] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    const target = targets.find((t) => t.def.name === targetName);
    const route = target?.routes.find((r) => r.path === routePath);
    if (!target || !route || route.navigation === false) continue;
    if (force || plans.routes[key]?.signature !== harvest.signature) {
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
      navigation: config.navigation,
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
    const onlyTargets = list(parsed.flags.targets);
    const onlyRoutes = list(parsed.flags.routes);
    scope.shots = report.shots.filter(
      (s) =>
        s.platform === "web" &&
        shotInConfig(s, targets, planned) &&
        (!onlyTargets || onlyTargets.includes(s.target)) &&
        (!onlyRoutes || onlyRoutes.some((r) => s.route === r || s.route === `/${r}` || s.routeName === r)),
    );
    scope.shotsById = new Map(scope.shots.map((s) => [s.id, s]));
  }
  return { costUsd, refreshed: capped.length };
}
