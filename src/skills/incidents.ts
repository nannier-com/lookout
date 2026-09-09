/**
 * The incident log: what has actually gone wrong with lookout itself.
 *
 * `events.jsonl` cannot serve this. It is narration of one run and every
 * capture truncates it, so the failure that happened yesterday is gone by the
 * time anybody could act on it. Incidents are the opposite: append-only, and
 * kept where the failure happened, which is the project lookout was pointed
 * at. The one writer allowed to rewrite the file is self-heal's compaction
 * (entries older than 90 days, only once a log outgrows 2000 lines), under
 * its lock.
 *
 * A log per project rather than one per machine. It is still never committed,
 * because `.lookout/` is gitignored, and it is now legible: the failures in
 * front of you are the failures of the thing in front of you. What that costs
 * is clustering across projects, so a bug seen once in each of three projects
 * no longer adds up to a heavy one; `self-heal` answers that by reading every
 * source it is pointed at rather than by pooling everything in advance.
 *
 * Nothing here creates a `.lookout/` where lookout has no config. A failure
 * with no configured project in scope goes to lookout's own checkout, and on
 * an installed package, where there is no checkout and no self-heal to read
 * it, it is dropped.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { LOOKOUT_DIR, locateConfig } from "../config-locate.js";
import { ownCheckout } from "../checkout.js";

export type IncidentKind =
  | "crash"
  | "operator-error"
  | "judge-unparseable"
  | "judge-rejected"
  | "skill-rollback"
  | "self-heal-rollback"
  | "healer-unparseable"
  /** A mapped screen the walk could not reach, after replay and the navigator both tried. */
  | "screen-unreachable";

export interface Incident {
  at: string;
  kind: IncidentKind;
  /** The verb that was running, when it is known. */
  verb?: string;
  message: string;
  /** Stack, reply head, or whatever else names the cause. */
  detail?: string;
  /**
   * Which project it happened in, by directory. Absolute, and a directory
   * rather than a display name: it is what decides which log the entry is
   * appended to, and what `self-heal` reads to find a project that can grade
   * a replay.
   */
  project?: string;
  /** Which judge panel was answering, when one was. */
  judge?: string;
  version?: string;
}

export function incidentsPath(projectDir: string): string {
  return join(projectDir, LOOKOUT_DIR, "incidents.jsonl");
}

/**
 * Which log an incident belongs in, or null when it belongs in none.
 *
 * A configured project first: `locateConfig` climbs to the root that holds a
 * `lookout.config.*`, so a failure in a subdirectory lands in the project's
 * own log rather than beside whatever the operator happened to `cd` into.
 * Failing that, lookout's own checkout, which is where a failure of `doctor`
 * or a mistyped verb actually belongs. Failing that, nowhere: writing into an
 * arbitrary directory would leave an un-ignored `.lookout/` in it.
 */
export function incidentLogDir(where: string | undefined): string | null {
  // Only an absolute path names a project. `locateConfig` resolves whatever it
  // is handed against the working directory and climbs, so a display name such
  // as "p" would land in whichever repository the process happened to be
  // standing in: the one log a test pointing `LOOKOUT_CHECKOUT` at a fixture
  // is trying not to write to. The field is documented absolute; this is what
  // makes that true.
  const configured = where && isAbsolute(where) ? locateConfig(where)?.projectDir : null;
  return configured ?? ownCheckout();
}

/**
 * Record one incident, in the log of the project it happened in.
 *
 * Synchronous and swallowing: this runs inside the top-level error handler,
 * and a logger that can throw there would replace the real failure with its
 * own.
 */
export function recordIncident(incident: Incident): void {
  try {
    const dir = incidentLogDir(incident.project);
    if (!dir) return;
    const p = incidentsPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(incident) + "\n");
  } catch {
    // A log that cannot be written is not worth failing the run over.
  }
}

/**
 * Every log a run should read, deduped, in the order given.
 *
 * `self-heal` and `doctor` are the two readers that legitimately span more
 * than one project: what they report on is lookout, and lookout's failures
 * are spread across the projects it was pointed at plus its own checkout.
 * Nulls are accepted so a caller can pass `ownCheckout()` without guarding.
 */
export function incidentSources(...dirs: (string | null | undefined)[]): string[] {
  return [...new Set(dirs.filter((d): d is string => !!d))];
}

/** Those logs read as one, oldest first, so clustering sees every occurrence. */
export function readIncidentsFrom(dirs: string[], limit = 2000): Incident[] {
  return dirs
    .flatMap((d) => readIncidents(d, limit))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
export function readIncidents(projectDir: string, limit = 2000): Incident[] {
  const p = incidentsPath(projectDir);
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
