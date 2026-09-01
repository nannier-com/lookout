/**
 * The incident log: what has actually gone wrong with lookout itself.
 *
 * `events.jsonl` cannot serve this. It is narration of one run and every
 * capture truncates it, so the failure that happened yesterday in another
 * project is gone by the time anybody could act on it. Incidents are the
 * opposite: append-only and pooled across every project on this machine,
 * because the thing they describe is lookout, not the app it was looking at.
 * The one writer allowed to rewrite it is self-heal's compaction (entries
 * older than 90 days, only once the log outgrows 2000 lines), under its lock.
 *
 * They live under the operator's home rather than in any repository. A failure
 * in someone's project is not that project's business to commit, and lookout's
 * own checkout should not accumulate a log of its bad days either.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookoutHome } from "../home.js";

export type IncidentKind =
  | "crash"
  | "operator-error"
  | "judge-unparseable"
  | "judge-rejected"
  | "skill-rollback"
  | "self-heal-rollback"
  | "healer-unparseable";

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
  /** Which judge panel was answering, when one was. */
  judge?: string;
  version?: string;
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

/** The shape of a failure: numbers and paths stripped, so occurrences group. */
export function shapeOf(message: string): string {
  return message.replace(/\d+/g, "N").replace(/\/[^\s:,]+/g, "PATH").slice(0, 160);
}

/**
 * The most recent incidents, newest last, capped so one read stays bounded.
 * The cap used to be 200, which quietly interacted with count-sorted
 * clustering: an old high-frequency bug aged out of the read window while
 * still dominating a person's mental model of what keeps breaking.
 */
export function readIncidents(limit = 2000): Incident[] {
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

/**
 * Incidents that look like the same failure, grouped, most frequent first.
 * Pass `sinceDays` to make the counts mean PRESSURE (occurrences inside the
 * window), which is what heal selection uses: an all-time count made a bug
 * fixed months ago outrank the one that broke yesterday. Without it, the
 * grouping is the all-time record, which is what a page listing history
 * wants.
 */
export function clusterIncidents(
  incidents: Incident[],
  opts: { sinceDays?: number; now?: string } = {},
): {
  kind: IncidentKind;
  message: string;
  count: number;
  latest: Incident;
}[] {
  const cutoff =
    opts.sinceDays === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(opts.now ?? new Date().toISOString()) - opts.sinceDays * 86_400_000;
  const groups = new Map<string, { kind: IncidentKind; message: string; count: number; latest: Incident }>();
  for (const i of incidents) {
    if (Number.isFinite(cutoff) && Date.parse(i.at) < cutoff) continue;
    // Numbers and paths differ between occurrences of one bug; the shape does
    // not, so they are stripped before grouping.
    const shape = shapeOf(i.message);
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
