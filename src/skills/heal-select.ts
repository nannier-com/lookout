/**
 * Which failure a self-heal works on, and what stands between it and the
 * incident log.
 *
 * lookout picks the group, not the model: "one incident group per run" was a
 * sentence in the prompt, and a rule only the prompt enforces is a rule. The
 * pick is deterministic (highest windowed pressure among ACTIVE groups,
 * newest occurrence breaking ties), which also makes the healed-marker
 * mechanical: lookout knows exactly which group it healed.
 *
 * Heals live with the checkout they changed. A group with no occurrences after
 * its latest heal is settled and stops counting as pressure; one that keeps
 * occurring is `recurred`, the loudest state there is, because a fix that
 * did not stick is worse news than a fresh bug.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG_FILENAME } from "../config-locate.js";
import {
  clusterIncidents,
  incidentsPath,
  shapeOf,
  type Incident,
  type IncidentKind,
} from "./incidents.js";
import { lookoutHome } from "../home.js";

export interface Heal {
  at: string;
  kind: IncidentKind;
  shape: string;
  commit: string;
}

export interface ActiveGroup {
  kind: IncidentKind;
  message: string;
  /** Occurrences in the window AFTER the latest matching heal. */
  count: number;
  latest: Incident;
  /** Healed before, and it came back. */
  recurred: boolean;
  /** Reverted heal attempts on record for this group. */
  failedAttempts: number;
}

export function healsPath(): string {
  return join(lookoutHome(), "heals.jsonl");
}

export function readHeals(): Heal[] {
  const p = healsPath();
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Heal;
        } catch {
          return null;
        }
      })
      .filter((h): h is Heal => h !== null);
  } catch {
    return [];
  }
}

export function recordHeal(heal: Heal): void {
  try {
    appendFileSync(healsPath(), JSON.stringify(heal) + "\n");
  } catch {
    // Losing the marker costs one re-offered group, not the heal itself.
  }
}

/**
 * The groups still exerting pressure: windowed occurrences after the latest
 * matching heal, with the failed-attempt count that says "needs a person".
 */
export function activeGroups(
  incidents: Incident[],
  heals: Heal[],
  opts: { sinceDays?: number; now?: string } = {},
): ActiveGroup[] {
  const healedAt = new Map<string, string>();
  for (const h of heals) {
    const key = `${h.kind}|${h.shape}`;
    if ((healedAt.get(key) ?? "") < h.at) healedAt.set(key, h.at);
  }
  // Rollback attempts carry the target group's shape in their detail, which
  // is what lets "this one keeps failing to heal" be counted at all.
  const rollbacks = incidents.filter((i) => i.kind === "self-heal-rollback");

  const out: ActiveGroup[] = [];
  for (const g of clusterIncidents(incidents, { sinceDays: opts.sinceDays ?? 30, now: opts.now })) {
    const healMark = healedAt.get(`${g.kind}|${g.message}`);
    const occurrences = incidents.filter(
      (i) => i.kind === g.kind && shapeOf(i.message) === g.message && (!healMark || i.at > healMark),
    );
    if (healMark && occurrences.length === 0) continue; // settled
    out.push({
      kind: g.kind,
      message: g.message,
      count: healMark ? occurrences.length : g.count,
      latest: occurrences.at(-1) ?? g.latest,
      recurred: !!healMark,
      failedAttempts: rollbacks.filter((r) => (r.detail ?? "").includes(g.message)).length,
    });
  }
  // Recurred groups first, then pressure, then recency: a fix that did not
  // stick outranks everything at equal weight.
  return out.sort(
    (a, b) =>
      Number(b.recurred) - Number(a.recurred) || b.count - a.count || (b.latest.at < a.latest.at ? -1 : 1),
  );
}

/**
 * The one group this run works on: the heaviest active group that is not a
 * record of healing itself failing and has not already burned two attempts.
 */
export function pickGroup(groups: ActiveGroup[]): {
  picked: ActiveGroup | null;
  skipped: { group: ActiveGroup; why: string }[];
} {
  const skipped: { group: ActiveGroup; why: string }[] = [];
  let fallback: ActiveGroup | null = null;
  for (const g of groups) {
    if (g.failedAttempts >= 2) {
      skipped.push({ group: g, why: `${g.failedAttempts} reverted attempts; needs a person` });
      continue;
    }
    if (g.kind === "self-heal-rollback") {
      // Healing "healing failed" while anything else is active chases its
      // own tail; it is only ever the last thing left.
      fallback ??= g;
      continue;
    }
    return { picked: g, skipped };
  }
  return { picked: fallback, skipped };
}

/**
 * Projects whose frozen sets can grade a heal, newest incident first. Used
 * when --project was not given: the replay gate should not be an opt-in
 * while the protocol describes it as part of the bar.
 */
export async function discoverReplayProjects(incidents: Incident[], limit = 2): Promise<string[]> {
  const { loadRegressionSet, usableCases } = await import("./regression.js");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of [...incidents].reverse()) {
    const dir = i.project;
    if (!dir || seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);
    const resolved = {
      projectDir: dir,
      configPath: join(dir, CONFIG_FILENAME),
      project: basename(dir),
      config: { targets: [] },
    } as never;
    try {
      const set = await loadRegressionSet(resolved);
      if (set && usableCases(resolved, set).length > 0) out.push(dir);
    } catch {
      // A project that cannot even load a manifest cannot grade anything.
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Drop incidents older than 90 days once a log exceeds 2000 lines. Called
 * only under the self-heal lock, the one writer allowed to rewrite the files
 * everybody else only appends to, and called once per source: each project
 * keeps its own log and each grows at its own rate.
 */
export function compactIncidents(projectDir: string, now = new Date().toISOString()): number {
  const p = incidentsPath(projectDir);
  if (!existsSync(p)) return 0;
  try {
    const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length <= 2000) return 0;
    const cutoff = Date.parse(now) - 90 * 86_400_000;
    const kept = lines.filter((l) => {
      try {
        return Date.parse((JSON.parse(l) as Incident).at) >= cutoff;
      } catch {
        return false;
      }
    });
    if (kept.length === lines.length) return 0;
    writeFileSync(p, kept.join("\n") + "\n");
    return lines.length - kept.length;
  } catch {
    return 0;
  }
}
