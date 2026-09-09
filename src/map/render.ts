/**
 * The map as a person reads it on a terminal, and as an agent reads it with
 * --json. One tree per target, one line per screen: where it sits, what
 * opens it, where it came from.
 */
import { relative } from "node:path";
import type { MapRunResult, TargetRun } from "./run.js";
import { screenAxes, walkNodes, type MapFile, type MapNode, type MapTarget } from "./store.js";

function openBrief(node: MapNode): string {
  if (!node.open) return node.kind === "route" ? "by url" : "";
  const o = node.open;
  if (o.affordance) return `${o.affordance.role} ${JSON.stringify(o.affordance.name)}`;
  if (o.deepLink) return `deep link ${o.deepLink}`;
  if (o.tap) return `tap ${JSON.stringify(o.tap.label)}`;
  return o.outcome;
}

function sourceBrief(node: MapNode, projectDir: string): string {
  const rel = relative(projectDir, node.source.path) || ".";
  return node.source.line ? `${rel}:${node.source.line}` : rel;
}

function statusLine(run: TargetRun, target: MapTarget | undefined): string {
  const what =
    run.status === "fresh"
      ? "fresh"
      : run.status === "failed"
        ? `FAILED (${run.reasons.join("; ")})`
        : `scanned (${run.reasons.join(", ")})`;
  const counts = `${run.screens} screen(s): ${run.routes} route(s), ${run.states} state(s)`;
  const cost = run.status === "scanned" ? `; ~$${run.costUsd.toFixed(4)}` : "";
  return `${run.name}  ${target?.url ?? ""}  ${what}  ${counts}${cost}`;
}

/** The printed report: one block per target, indented by depth. */
export function renderMap(result: MapRunResult, projectDir: string): string {
  const lines: string[] = [`map: ${result.path}`];
  for (const run of result.targets) {
    const target = result.file?.targets[run.name];
    lines.push(statusLine(run, target));
    if (!target) continue;
    walkNodes(target.roots, (node, routeAncestor, depth) => {
      const axes = screenAxes(node, routeAncestor);
      const label = node.kind === "route" ? node.path! : axes.state;
      const marks = [
        node.open?.outcome ?? "",
        node.risk !== "safe" ? node.risk.toUpperCase() : "",
        `[${node.platforms.join(", ")}]`,
      ].filter(Boolean);
      const walked = node.walk?.reached ? "  walked" : "";
      lines.push(
        `  ${"  ".repeat(depth)}${label.padEnd(Math.max(2, 22 - depth * 2))} ${node.title.slice(0, 28).padEnd(28)} ${marks.join(" ").padEnd(24)} ${sourceBrief(node, projectDir)}${node.open ? `  ${openBrief(node)}` : ""}${walked}`,
      );
    });
    for (const s of target.skipped) lines.push(`  skipped: ${s.what} (${s.reason})`);
    const dropped = target.notes.filter((n) => n.startsWith("dropped") || n.startsWith("pruned"));
    if (dropped.length > 0) lines.push(`  notes: ${dropped.length} node(s) dropped or pruned; --json lists them`);
  }
  if (result.costUsd > 0) lines.push(`~$${result.costUsd.toFixed(4)}`);
  return lines.join("\n");
}

/** The --json shape: the run per target plus the tree itself. */
export function mapJson(result: MapRunResult): unknown {
  const targets: Record<string, unknown> = {};
  for (const run of result.targets) {
    const target = result.file?.targets[run.name];
    targets[run.name] = {
      status: run.status,
      reasons: run.reasons,
      screens: run.screens,
      routes: run.routes,
      states: run.states,
      costUsd: run.costUsd,
      notes: run.notes,
      mappedAt: target?.mappedAt ?? null,
      signature: target?.signature ?? null,
      roots: target?.roots ?? [],
      skipped: target?.skipped ?? [],
    };
  }
  return { path: result.path, costUsd: result.costUsd, targets };
}

export type { MapFile };
