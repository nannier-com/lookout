/**
 * What lookout has been changing about itself.
 *
 * Two of lookout's verbs point at lookout rather than at an application.
 * `skills improve` reads the signals a project has produced and amends the
 * instructions the judge runs on; `self-heal` reads the incident log and edits
 * lookout's own TypeScript. Both are gated, both write down what they did, and
 * both wrote it down somewhere nobody looks: a JSONL file under
 * `.lookout/skills/`, a reverted diff under the operator's home, a commit in a
 * checkout the reader may not even have open.
 *
 * This gathers that record into one answer, so the page can show it. It is
 * assembled from files those verbs already write, which means it is true
 * whether or not anything is running and whoever ran it: nothing here is new
 * instrumentation, and nothing here is a claim lookout makes about itself
 * without a file behind it.
 *
 * The two tracks are kept apart on purpose, because their blast radius is not
 * the same. An amendment changes what this project's judge believes and lives
 * in this project's own directory. A heal changes the code every project on
 * this machine runs, which is why its record is machine-wide and its evidence
 * is a git commit.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { lookoutDir } from "../config.js";
import { clusterIncidents, incidentsPath, lookoutHome, readIncidents } from "../skills/incidents.js";
import { loadSkill } from "../skills/load.js";
import { loadRegressionSet, regressionManifestPath } from "../skills/regression.js";
import { bySkill, gatherSignals } from "../skills/signals.js";
import { historyPath, improveLockPath, SKILL_NAMES } from "../verbs/skills.js";
import { lockPath, ownCheckout } from "../verbs/self-heal.js";
import { execFileAsync, lockHeld } from "../util.js";
import type { ResolvedConfig } from "../types.js";

/** One of lookout's instruction files, as it stands in this project. */
export interface SkillState {
  name: string;
  description: string;
  version: number;
  /** Absolute path of this project's layer, when it has written one. */
  amendmentPath: string | null;
  /** An amendment nothing could grade, waiting for a person to read it. */
  proposalPath: string | null;
}

/** One line of `.lookout/skills/history.jsonl`, as the page reads it. */
export interface LearningEntry {
  at: string;
  skill: string;
  action: "applied" | "rolled-back" | "proposed" | "no-change";
  summary: string;
  version?: number;
  evidence?: string[];
  /** What the frozen set caught, on a rollback. */
  violations?: { kind: string; shotId: string; category: string; why: string }[];
}

/** A failure lookout keeps hitting, with the occurrences folded together. */
export interface IncidentGroup {
  kind: string;
  message: string;
  count: number;
  latestAt: string;
  verb: string | null;
  detail: string | null;
}

/** A heal that was written, failed a gate, and was reverted. */
export interface HealAttempt {
  at: string;
  /** Where the diff and the gate output were kept. */
  dir: string;
  summary: string | null;
  cause: string | null;
  failedGates: string[];
}

/** A heal that passed every gate and is now in the history of the checkout. */
export interface HealCommit {
  sha: string;
  at: string;
  subject: string;
}

export interface Learning {
  /** What is happening this second, from the locks the two verbs hold. */
  running: { improve: boolean; heal: boolean };
  /** The instructions track: this project's judge, and how it has moved. */
  instructions: {
    skills: SkillState[];
    history: LearningEntry[];
    /** The evidence that gates an amendment, or null when nothing is frozen. */
    frozen: { cases: number; claims: number; frozenAt: string } | null;
    /** What lookout would learn from next, and has not yet. */
    pending: { total: number; bySkill: { skill: string; count: number }[] };
  };
  /** The source track: lookout's own code, pooled across every project. */
  code: {
    /** lookout's checkout, or null when this is an installed package. */
    checkout: string | null;
    incidents: IncidentGroup[];
    attempts: HealAttempt[];
    commits: HealCommit[];
  };
}

/** Newest first, and capped: this is a record to read, not an archive. */
const MAX_HISTORY = 40;
const MAX_INCIDENT_GROUPS = 12;
const MAX_ATTEMPTS = 8;
const MAX_COMMITS = 12;

/**
 * A key that moves when anything this reads moves.
 *
 * The page polls, and assembling this touches a dozen files plus a git log, so
 * the answer is held until one of them changes. The lock files are part of the
 * key because a run starting or finishing is precisely the moment the page has
 * to repaint, and neither writes anything else while it is going.
 */
export function learningKey(resolved: ResolvedConfig): string {
  const parts: string[] = [];
  for (const p of [
    historyPath(resolved),
    improveLockPath(resolved),
    join(lookoutDir(resolved), "skills"),
    regressionManifestPath(resolved),
    incidentsPath(),
    lockPath(),
    join(lookoutHome(), "self-heal"),
  ]) {
    try {
      const st = statSync(p);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

async function readHistory(resolved: ResolvedConfig): Promise<LearningEntry[]> {
  const p = historyPath(resolved);
  if (!existsSync(p)) return [];
  try {
    const lines = (await readFile(p, "utf8")).trim().split("\n").filter(Boolean);
    const entries: LearningEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as LearningEntry);
      } catch {
        // One unreadable line is not a reason to lose the rest of the record.
      }
    }
    return entries.reverse().slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

async function readSkills(resolved: ResolvedConfig): Promise<SkillState[]> {
  const out: SkillState[] = [];
  for (const name of SKILL_NAMES) {
    try {
      const skill = await loadSkill(resolved, name);
      const proposal = join(lookoutDir(resolved), "skills", name, "PROPOSED.md");
      out.push({
        name: skill.name,
        description: skill.description,
        version: skill.version,
        amendmentPath: skill.amendmentPath,
        proposalPath: existsSync(proposal) ? proposal : null,
      });
    } catch {
      // A skill file that will not load is the judge's problem to report, not
      // this page's: it says what it could read and leaves the rest out.
    }
  }
  return out;
}

/**
 * The attempts that were reverted, newest first.
 *
 * `self-heal` keeps the diff, the gate output and the model's own report of
 * every attempt a gate killed, which is the only place the reasoning behind a
 * rejected change survives. Reading it here is what turns that directory from
 * something an operator has to know about into something the page offers.
 */
async function readAttempts(): Promise<HealAttempt[]> {
  const root = join(lookoutHome(), "self-heal");
  if (!existsSync(root)) return [];
  let stamps: string[];
  try {
    stamps = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
      .slice(0, MAX_ATTEMPTS);
  } catch {
    return [];
  }
  const attempts: HealAttempt[] = [];
  for (const stamp of stamps) {
    const dir = join(root, stamp);
    let summary: string | null = null;
    let cause: string | null = null;
    try {
      const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as {
        summary?: string;
        cause?: string;
      };
      summary = report.summary ?? null;
      cause = report.cause ?? null;
    } catch {
      // An attempt with no readable report still counts: the diff is the point.
    }
    let failedGates: string[] = [];
    try {
      const gates = await readFile(join(dir, "gates.txt"), "utf8");
      failedGates = [...gates.matchAll(/^=== (.+?) \(FAIL\)/gm)].map((m) => m[1]!);
    } catch {
      failedGates = [];
    }
    // The directory is named for the moment the attempt started, with the
    // colons and the dot a timestamp carries replaced by dashes, because a
    // filesystem will not take them. Putting them back is what makes it a
    // timestamp the page can render.
    const at = stamp.replace(
      /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d+Z)$/,
      "$1:$2:$3.$4",
    );
    attempts.push({ at, dir, summary, cause, failedGates });
  }
  return attempts;
}

/**
 * The heals that stuck, read out of the checkout's own history.
 *
 * `self-heal` commits and never pushes, and every commit it writes carries the
 * same sentence saying where the fix came from. That sentence is the search,
 * matched literally: it finds the commits lookout wrote about itself without
 * needing a second record that could disagree with git, and without catching
 * the commits a person wrote ABOUT self-heal, which a looser phrase does.
 */
async function readCommits(checkout: string | null): Promise<HealCommit[]> {
  if (!checkout) return [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        `-n${MAX_COMMITS}`,
        "--fixed-strings",
        "--grep=Found by `lookout self-heal`",
        "--pretty=format:%h%x09%aI%x09%s",
      ],
      { cwd: checkout },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", at = "", ...rest] = line.split("\t");
        return { sha, at, subject: rest.join("\t") };
      });
  } catch {
    // No git, no history, or a checkout that is not one: nothing to show.
    return [];
  }
}

/**
 * Everything lookout has done to itself, for this project and this machine.
 *
 * Nothing here throws. The page that renders it is a viewer over whatever
 * happens to be on disk, and a half-written history file or an unreadable
 * incident log must degrade to a shorter answer rather than to a broken page.
 */
export async function buildLearning(resolved: ResolvedConfig): Promise<Learning> {
  const checkout = ownCheckout();
  const [skills, history, attempts, commits] = await Promise.all([
    readSkills(resolved),
    readHistory(resolved),
    readAttempts(),
    readCommits(checkout),
  ]);

  let frozen: Learning["instructions"]["frozen"] = null;
  try {
    const set = await loadRegressionSet(resolved);
    if (set) {
      frozen = {
        cases: set.cases.length,
        claims: set.cases.reduce((n, c) => n + c.mustFile.length + c.mustNotFile.length, 0),
        frozenAt: set.frozenAt,
      };
    }
  } catch {
    frozen = null;
  }

  let pending: Learning["instructions"]["pending"] = { total: 0, bySkill: [] };
  try {
    const signals = await gatherSignals(resolved);
    pending = {
      total: signals.length,
      bySkill: [...bySkill(signals)].map(([skill, s]) => ({ skill, count: s.length })),
    };
  } catch {
    // Signals are derived from the backlog, which the board already reports on.
  }

  const incidents = clusterIncidents(readIncidents())
    .slice(0, MAX_INCIDENT_GROUPS)
    .map((g) => ({
      kind: g.kind,
      message: g.message,
      count: g.count,
      latestAt: g.latest.at,
      verb: g.latest.verb ?? null,
      detail: g.latest.detail ?? null,
    }));

  return {
    running: { improve: lockHeld(improveLockPath(resolved)), heal: lockHeld(lockPath()) },
    instructions: { skills, history, frozen, pending },
    code: { checkout, incidents, attempts, commits },
  };
}

/**
 * The one-line version, for the sidebar.
 *
 * The badge exists so the icon can say "something is here" without the page
 * fetching the whole record on every poll: whether either verb is running, how
 * many amendments stuck, how many proposals are waiting to be read, and how
 * many failures are still recurring.
 */
export function learningBadge(l: Learning): {
  running: boolean;
  applied: number;
  proposed: number;
  incidents: number;
} {
  return {
    running: l.running.improve || l.running.heal,
    applied: l.instructions.history.filter((h) => h.action === "applied").length,
    proposed: l.instructions.skills.filter((s) => s.proposalPath).length,
    incidents: l.code.incidents.reduce((n, g) => n + g.count, 0),
  };
}
