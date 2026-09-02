/**
 * Facts the issue's two renderings share, derived once from the context.
 *
 * The markdown and the JSON record are twins: a fact the document states
 * belongs in the record too, and the only way to keep that true is for both
 * to read the same derivation. These are the derivations that are not a plain
 * field on the cluster or the record: which other issues sit on the same
 * screenshots, what a ruling will photograph, and where every artifact is.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lookoutDir } from "../config.js";
import { reportPath } from "../capture/store.js";
import { clusterKeyOf, clusterScope, configuredRoutesOf } from "../fix/cluster.js";
import { isShellRegion } from "../backlog/lib.js";
import { panelOf } from "../judge/panels.js";
import { ledgerPath } from "../judge/ledger.js";
import { navigationPath } from "../navigate/store.js";
import { eventsPath } from "../report/events.js";
import { DEFAULT_VIEWPORTS } from "../types.js";
import { issueIdsByKey } from "./registry.js";
import type { IssueContext } from "./context.js";

export interface SiblingFact {
  id: string;
  severity: string;
  category: string;
  attribute: string;
  title: string;
}

/**
 * The other open issues filed against the same screenshots, one row per
 * issue and defect however many screenshots they share. Empty without the
 * backlog in hand, or for a source finding, which has no screenshot.
 */
export function siblingsOf(ctx: IssueContext): SiblingFact[] {
  const { cluster, backlog } = ctx;
  if (!backlog || cluster.channel === "code") return [];
  const mine = new Set(cluster.fingerprints);
  const shotIds = new Set(cluster.members.flatMap((m) => m.evidence.map((e) => e.shotId)));
  const ids = issueIdsByKey(backlog);
  const rows = new Map<string, SiblingFact>();
  for (const f of Object.values(backlog.findings)) {
    if (mine.has(f.fingerprint)) continue;
    if (f.status !== "open" && f.status !== "blocked") continue;
    if (!f.evidence.some((e) => shotIds.has(e.shotId))) continue;
    const id = ids[clusterKeyOf(f)] ?? "not yet numbered";
    const key = `${id}|${f.attribute}`;
    if (rows.has(key)) continue;
    rows.set(key, { id, severity: f.severity, category: f.category, attribute: f.attribute, title: f.title });
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id) || a.attribute.localeCompare(b.attribute));
}

export interface ScopeFacts {
  target: string;
  url: string | null;
  startHint: string | null;
  /** Every route a ruling re-captures. */
  routes: string[];
  /** The ones the shell rule added from the config, not where this was filed. */
  added: string[];
  shell: boolean;
  /** The judge panel that re-judges, or null when lookout's own checks rule. */
  panel: string | null;
  formFactors: string[];
  schemes: string[];
}

/** What a ruling will photograph, from the same derivation the verb uses. Null for a source finding. */
export function scopeOf(ctx: IssueContext): ScopeFacts | null {
  const { cluster, resolved } = ctx;
  if (cluster.channel === "code") return null;
  const target = resolved.config.targets?.find((t) => t.name === cluster.target);
  const scope = clusterScope(cluster, configuredRoutesOf(resolved.config, cluster.target));
  return {
    target: cluster.target,
    url: target?.url ?? null,
    startHint: target?.startHint ?? null,
    routes: scope.routes,
    added: scope.routes.filter((r) => !cluster.routes.includes(r)),
    shell: cluster.members.some((m) => isShellRegion(m.region)),
    panel: cluster.channel === "ai" ? panelOf(cluster.category).name : null,
    formFactors: Object.keys(DEFAULT_VIEWPORTS),
    schemes: ["dark", "light"],
  };
}

export interface ArtifactFact {
  name: string;
  path: string;
  exists: boolean;
  /** Under the project's `.lookout/`, which outlives the capture workspace. */
  durable: boolean;
}

/** Where everything lookout wrote about this lives, absolute, with whether it is there now. */
export function artifactsOf(ctx: IssueContext): ArtifactFact[] {
  const { cluster, resolved, evDir } = ctx;
  const lk = lookoutDir(resolved);
  const rows: [string, string, boolean][] = [
    ["config", resolved.configPath ?? join(resolved.projectDir, "lookout.config.ts"), true],
    ["backlog", join(lk, "backlog.json"), true],
    ["judge ledger", ledgerPath(resolved), true],
    ["navigation plan", navigationPath(resolved), true],
    ["capture report", reportPath(resolved), false],
    ["judge report", join(evDir, "judge-report.json"), false],
    ["run log", eventsPath(resolved), false],
    ["contact sheet of the last check", join(evDir, "contact-sheet.png"), false],
    ["contact sheet of the last verify-fix of this issue", join(evDir, `verify-${cluster.id}.png`), false],
  ];
  // The panels' own replies about this issue's views, when the ledger points
  // at any and the workspace still holds them: the reasoning the findings
  // were distilled from, for the agent that wants more than the distillate.
  const shotIds = new Set(cluster.members.flatMap((m) => m.evidence.map((e) => e.shotId)));
  for (const entry of Object.values(ctx.ledger?.entries ?? {})) {
    if (!entry.reply || !entry.shotIds.some((id) => shotIds.has(id))) continue;
    rows.push([`judge transcript (${entry.panel}, run ${entry.runId})`, join(evDir, entry.reply), false]);
  }
  return rows.map(([name, path, durable]) => ({ name, path, exists: existsSync(path), durable }));
}
