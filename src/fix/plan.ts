/**
 * Writing the dispatch plan: briefs to disk, PLAN.json beside them.
 *
 * Shared by `check --auto` (which writes the whole plan) and `verify-fix`
 * (which rewrites one brief when a cluster comes back still open).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { nowIso } from "../util.js";
import type { ResolvedConfig } from "../types.js";
import type { FixCluster } from "./cluster.js";
import { PROTOCOL, renderBrief, type FixPlan, type PlanCluster } from "./brief.js";
import { briefPath, fixDir, loadState, planPath } from "./state.js";

/** Render and write one cluster's brief; returns its absolute path. */
export async function writeBrief(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  maxAttempts: number,
): Promise<string> {
  const state = await loadState(resolved, cluster.id);
  const p = briefPath(resolved, cluster.id);
  await mkdir(fixDir(resolved), { recursive: true });
  await writeFile(
    p,
    renderBrief(cluster, {
      resolved,
      attempt: cluster.attemptsSpent + 1,
      maxAttempts,
      priorAttempts: state.attempts,
    }),
  );
  return p;
}

export async function writeFixPlan(
  resolved: ResolvedConfig,
  clusters: FixCluster[],
  opts: { runId: string; maxAttempts: number },
): Promise<FixPlan> {
  const planClusters: PlanCluster[] = [];
  for (const c of clusters) {
    const brief = await writeBrief(resolved, c, opts.maxAttempts);
    planClusters.push({
      id: c.id,
      severity: c.severity,
      category: c.category,
      attribute: c.attribute,
      title: c.title,
      target: c.target,
      routes: c.routes,
      shotCount: c.shotCount,
      fingerprints: c.fingerprints,
      attempt: c.attemptsSpent + 1,
      brief: relative(resolved.projectDir, brief),
      verify: `lookout verify-fix --cluster ${c.id}`,
    });
  }
  const plan: FixPlan = {
    runId: opts.runId,
    project: resolved.project,
    generatedAt: nowIso(),
    repository: resolved.projectDir,
    maxAttempts: opts.maxAttempts,
    clusters: planClusters,
    protocol: PROTOCOL,
  };
  await mkdir(fixDir(resolved), { recursive: true });
  await writeFile(planPath(resolved), JSON.stringify(plan, null, 2));
  return plan;
}

/** The compact dispatch table `check --auto` prints for the calling session. */
export function renderDispatch(plan: FixPlan, resolved: ResolvedConfig): string {
  if (plan.clusters.length === 0) {
    return "auto: nothing to dispatch, no open findings match the severity filter";
  }
  const rows = plan.clusters.map(
    (c) =>
      `  ${c.id}\n` +
      `    ${c.severity.padEnd(8)} ${c.category}/${c.attribute}  ${c.shotCount} shot(s)  ${c.routes.join(" ")}\n` +
      `    brief:  ${c.brief}\n` +
      `    verify: ${c.verify}`,
  );
  return [
    `auto: ${plan.clusters.length} cluster(s) to dispatch (plan: ${relative(resolved.projectDir, planPath(resolved))})`,
    "",
    ...rows,
    "",
    "protocol:",
    ...plan.protocol.map((p, i) => `  ${i + 1}. ${p}`),
  ].join("\n");
}
