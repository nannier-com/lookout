/**
 * Brief rendering: a cluster becomes a self-contained prompt for one fix
 * session.
 *
 * lookout is driven by agents, not read by people, so a brief is written to be
 * executed rather than skimmed. Everything a fix session needs is in the file:
 * the defect, the screenshots to look at, the repository to change, the rules,
 * and the exact JSON it must reply with. The orchestrating session therefore
 * never has to carry findings in its own context; it passes a path.
 */
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import type { ResolvedConfig } from "../types.js";
import type { FixCluster } from "./cluster.js";
import type { AttemptRecord } from "./state.js";

export interface BriefContext {
  resolved: ResolvedConfig;
  attempt: number;
  maxAttempts: number;
  priorAttempts: AttemptRecord[];
  /** Absolute path of this cluster's contact sheet, when one was composited. */
  sheet?: string | null;
  /** Rule files governing the target repository, discovered by lookout. */
  ruleFiles?: string[];
}

/** Absolute path of a member's most recent screenshot. */
function latestEvidence(resolved: ResolvedConfig, m: FixCluster["members"][number]): string | null {
  const ev = m.evidence[m.evidence.length - 1];
  return ev ? join(evidenceDir(resolved), ev.path) : null;
}

/** Short name for the subagent working this cluster, so the session can say who is doing what. */
export function clusterLabel(c: FixCluster): string {
  const what = c.defects.length > 1 ? `${c.category} (${c.defects.length} rules)` : `${c.category}/${c.attribute}`;
  const where = c.routes.length > 2 ? `${c.routes.length} routes` : c.routes.join(" ");
  return `fix ${what} on ${where}`;
}

/**
 * The exact instruction the orchestrating session follows to dispatch this
 * cluster. It names the subagent, so the run shows who is fixing what rather
 * than a row of anonymous workers.
 */
export function spawnLine(c: FixCluster, briefPath: string): string {
  return (
    `spawn: announce "${clusterLabel(c)}", then start ONE separate agent session\n` +
    `          (subagent, task, worker: whatever your harness calls a child session\n` +
    `          with its own context) named "${clusterLabel(c)}", whose entire prompt is:\n` +
    `          "Open ${briefPath} and execute it fully.\n` +
    `          Reply with only the JSON it asks for."`
  );
}

export function renderBrief(cluster: FixCluster, ctx: BriefContext): string {
  const { resolved, attempt, maxAttempts, priorAttempts } = ctx;
  const ruleFiles = ctx.ruleFiles ?? [];
  // One screenshot can carry several findings, so dedupe by path: listing the
  // same image five times tells a fix session nothing and wastes its reads.
  const seenShots = new Set<string>();
  const shots: string[] = [];
  for (const m of cluster.members) {
    const p = latestEvidence(resolved, m);
    if (!p || seenShots.has(p)) continue;
    seenShots.add(p);
    shots.push(`- ${p}\n  route ${m.route}, ${m.formFactor}, ${m.scheme} scheme, state ${m.state}`);
  }

  const lines: string[] = [];

  lines.push(`# Fix brief: ${cluster.title}`, "");
  lines.push("```", `cluster:    ${cluster.id}`);
  lines.push(`attempt:    ${attempt} of ${maxAttempts}`);
  lines.push(`severity:   ${cluster.severity}`);
  lines.push(
    `defect:     ${cluster.category}${cluster.defects.length > 1 ? ` (${cluster.defects.length} rules)` : `/${cluster.attribute}`}`,
  );
  lines.push(`found by:   ${cluster.channel === "ai" ? `visual judge${cluster.verified ? ", adversarially verified" : ""}` : "deterministic check"}`);
  lines.push(`repository: ${resolved.projectDir}`);
  lines.push(
    `affects:    ${cluster.shotCount} screenshot(s) across ${cluster.routes.length} route(s)` +
      (cluster.findingCount > cluster.shotCount ? `, ${cluster.findingCount} findings` : ""),
  );
  lines.push("```", "");

  lines.push("## Task", "");
  lines.push(
    cluster.defects.length > 1
      ? "A group of visual defects that share a likely cause, found by lookout in the"
      : "One visual defect, found by lookout in the",
    cluster.defects.length > 1
      ? "running application and filed against the screenshots listed below. Find the"
      : "running application and filed against the screenshots listed below. Find its",
    "root cause in the repository named above, fix it, commit, and report back.",
    cluster.defects.length > 1
      ? "Work only on this cluster."
      : "Work only on this defect.",
    "",
  );

  // Rules before evidence: an agent that starts editing before it knows the
  // project's conventions has already done the damage by the time it reads
  // them. lookout cannot rely on the agent's harness having loaded these, so it
  // names them.
  lines.push("## Project rules: read these FIRST", "");
  if (ruleFiles.length > 0) {
    lines.push(
      "This repository carries rules that govern how changes are made in it.",
      "Read every one of these before you edit anything:",
      "",
      ...ruleFiles.map((f) => `- ${f}`),
      "",
      "They are not advisory. Where a project rule conflicts with anything in this",
      "brief, the project rule wins and you say so in your reply. Where it forbids",
      "the obvious fix, find the one it allows rather than the one it forbids.",
      "",
    );
  } else {
    lines.push(
      "lookout found no rules file (CLAUDE.md, AGENTS.md, CONVENTIONS.md and the",
      "like) governing this repository. Before editing, look for conventions in the",
      "surrounding code and match them; do not introduce a new pattern.",
      "",
    );
  }

  const heading = cluster.channel === "ai" ? "## What the judge saw" : "## What the checks found";
  lines.push(heading, "");
  if (cluster.defects.length > 1) {
    // A grouped cluster (co-located accessibility violations, say) is several
    // reported defects with one likely cause. Show all of them: fixing only the
    // one that happened to be worst leaves the cluster open on the next ruling.
    lines.push(
      `${cluster.defects.length} reported defects, grouped because they share a likely cause.`,
      "All of them must be gone for this cluster to pass.",
      "",
    );
    cluster.defects.forEach((d, i) => {
      lines.push(`${i + 1}. **${d.attribute}** (${d.severity}) ${d.title}`);
      if (d.problem && d.problem !== d.title) lines.push(`   ${d.problem}`);
    });
    lines.push("");
  } else {
    lines.push(cluster.problem, "");
  }
  if (cluster.expected) lines.push(`**Expected.** ${cluster.expected}`, "");
  if (cluster.observed) lines.push(`**Observed.** ${cluster.observed}`, "");

  lines.push("## Evidence", "");
  if (ctx.sheet) {
    lines.push(
      "Start with the contact sheet: one image, every affected screenshot, labelled.",
      "",
      `- ${ctx.sheet}`,
      "",
      "Then open the full-resolution shots below for anything the sheet crops or",
      "downscales. You must actually view these images, not infer from filenames.",
      "",
    );
  } else {
    lines.push(
      "Open every one of these images before you edit anything. You must actually",
      "view them, not infer from the filenames.",
      "",
    );
  }
  lines.push(...shots, "");
  if (cluster.routes.length > 1) {
    lines.push(
      `The same defect appears on ${cluster.routes.length} routes (${cluster.routes.join(", ")}),`,
      "which usually means one shared cause rather than one bug per route.",
      "",
    );
  }

  if (attempt > 1 && priorAttempts.length > 0) {
    lines.push(`## Attempt ${attempt - 1} did not fix this`, "");
    for (const a of priorAttempts) {
      lines.push(`**Attempt ${a.n}** (${a.verdict ?? "unresolved"})`);
      if (a.reported?.note) lines.push(`- what was tried: ${a.reported.note}`);
      if (a.reported?.commit) lines.push(`- commit: ${a.reported.commit}`);
      if (a.judgeNote) lines.push(`- what the judge still saw afterwards: ${a.judgeNote}`);
      lines.push("");
    }
    lines.push(
      "Do not repeat the previous approach. If the earlier change was wrong,",
      "revert it as part of this attempt rather than layering a second fix on top.",
      "",
    );
  }

  lines.push("## Rules", "");
  lines.push(
    "1. Look first. The defect is visual, and you cannot fix what you have not seen.",
    "2. Fix the root cause, not the individual screenshots. Screenshots are symptoms.",
    "3. Obey the project rules listed above, and match the surrounding code before",
    "   adding anything new.",
    "4. Do not edit anything under `.lookout/`. The backlog and the evidence belong",
    "   to lookout and are written by it alone.",
    "5. Do not run lookout, and do not judge your own work. A separate verification",
    "   pass rules on whether this is fixed. Self-assessment is not accepted.",
    "6. Stay inside this cluster. Unrelated improvements you notice belong in",
    "   separate work, not in this commit.",
    "7. Commit your change in the repository named above before reporting back.",
    "",
  );

  lines.push("## Report back", "");
  lines.push(
    "Your final message must be exactly this JSON object and nothing else:",
    "",
    "```json",
    "{",
    `  "cluster": "${cluster.id}",`,
    '  "outcome": "fixed" | "not-code-fixable" | "gave-up",',
    '  "commit": "<sha of your commit, or null>",',
    '  "rootCause": "<one line: what was actually wrong>",',
    '  "change": "<one line: what you changed>",',
    '  "files": ["<paths you edited>"]',
    "}",
    "```",
    "",
    'Use `"not-code-fixable"` when the defect comes from configuration, seeded data,',
    "or the environment rather than from code, and name which in `rootCause`.",
    'Use `"gave-up"` when you could not locate the cause, and say what you ruled out',
    "in `rootCause` so the next attempt does not repeat your search.",
    "",
  );

  return lines.join("\n");
}

export interface PlanCluster {
  id: string;
  /** What to call the subagent that works this cluster. */
  label: string;
  /** The dispatch instruction, verbatim. */
  spawn: string;
  /** Contact sheet for this cluster, or null when none could be composited. */
  sheet: string | null;
  severity: FixCluster["severity"];
  category: string;
  attribute: string;
  title: string;
  target: string;
  routes: string[];
  shotCount: number;
  fingerprints: string[];
  attempt: number;
  brief: string;
  verify: string;
}

export interface FixPlan {
  runId: string;
  project: string;
  generatedAt: string;
  repository: string;
  maxAttempts: number;
  clusters: PlanCluster[];
  /** How the orchestrating session is meant to execute this plan. */
  protocol: string[];
}

export const PROTOCOL: string[] = [
  "For each cluster below, ANNOUNCE what you are about to fix and who is fixing it " +
    "(the cluster's `label`), then start ONE separate agent session under that name: a " +
    "subagent, task, worker, or whatever your harness calls a child session with its own " +
    "context. Its entire prompt is: \"Open <brief> and execute it fully. Reply with only " +
    "the JSON it asks for.\" Keeping the brief out of your own context is the point: you " +
    "hold ids and verdicts, the child session holds the screenshots. Say which session is " +
    "on which cluster as you go, and report each verdict as it lands, so the run is " +
    "legible while it runs.",
  "Clusters touching different targets or routes can run in parallel. Clusters that " +
    "share a route must run one at a time, or the fix sessions will collide in the same files.",
  "When a session replies, run its cluster's verify command, passing what it reported: " +
    "`lookout verify-fix --cluster <id> --commit <sha> --note \"<rootCause>\"`.",
  "Branch on the verify exit code: 0 the fix is confirmed and the backlog is already " +
    "adjudicated, so move on. 1 it is not fixed and a fresh brief has been written, so " +
    "spawn a NEW subagent on that same brief path. 2 lookout failed to run. 3 the cluster " +
    "is blocked after exhausting its attempts, so stop dispatching it and report it.",
  "Never mark a finding fixed yourself, and never let a fix session verify its own work. " +
    "lookout is the only thing that rules on whether a defect is gone.",
];
