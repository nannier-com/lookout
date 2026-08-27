/**
 * The incident log: what has actually gone wrong with lookout itself.
 *
 * `events.jsonl` cannot serve this. It is narration of one run and every
 * capture truncates it, so the failure that happened yesterday in another
 * project is gone by the time anybody could act on it. Incidents are the
 * opposite: append-only, never truncated, and pooled across every project on
 * this machine, because the thing they describe is lookout, not the app it was
 * looking at.
 *
 * They live under the operator's home rather than in any repository. A failure
 * in someone's project is not that project's business to commit, and lookout's
 * own checkout should not accumulate a log of its bad days either.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type IncidentKind =
  | "crash"
  | "operator-error"
  | "judge-unparseable"
  | "judge-rejected"
  | "skill-rollback"
  | "self-heal-rollback";

export interface Incident {
  at: string;
  kind: IncidentKind;
  /** The verb that was running, when it is known. */
  verb?: string;
  message: string;
  /** Stack, reply head, or whatever else names the cause. */
  detail?: string;
  /** Which project it happened in, by directory. */
  project?: string;
  version?: string;
}

/** Overridable so a test does not write into the operator's home. */
export function lookoutHome(): string {
  return process.env.LOOKOUT_HOME ?? join(homedir(), ".lookout");
}

export function incidentsPath(): string {
  return join(lookoutHome(), "incidents.jsonl");
}

/**
 * Record one incident. Synchronous and swallowing: this runs inside the
 * top-level error handler, and a logger that can throw there would replace the
 * real failure with its own.
 */
export function recordIncident(incident: Incident): void {
  try {
    const p = incidentsPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(incident) + "\n");
  } catch {
    // A log that cannot be written is not worth failing the run over.
  }
}

/** The most recent incidents, newest last, capped so one read stays bounded. */
export function readIncidents(limit = 200): Incident[] {
  const p = incidentsPath();
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as Incident;
        } catch {
          return null;
        }
      })
      .filter((i): i is Incident => i !== null);
  } catch {
    return [];
  }
}

/** Incidents that look like the same failure, grouped, most frequent first. */
export function clusterIncidents(incidents: Incident[]): {
  kind: IncidentKind;
  message: string;
  count: number;
  latest: Incident;
}[] {
  const groups = new Map<string, { kind: IncidentKind; message: string; count: number; latest: Incident }>();
  for (const i of incidents) {
    // Numbers and paths differ between occurrences of one bug; the shape does
    // not, so they are stripped before grouping.
    const shape = i.message.replace(/\d+/g, "N").replace(/\/[^\s:,]+/g, "PATH").slice(0, 160);
    const key = `${i.kind}|${shape}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.latest = i;
    } else {
      groups.set(key, { kind: i.kind, message: shape, count: 1, latest: i });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
