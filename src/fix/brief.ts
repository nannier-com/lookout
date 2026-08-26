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
}

/** Absolute path of a member's most recent screenshot. */
function latestEvidence(resolved: ResolvedConfig, m: FixCluster["members"][number]): string | null {
  const ev = m.evidence[m.evidence.length - 1];
  return ev ? join(evidenceDir(resolved), ev.path) : null;
}

export function renderBrief(cluster: FixCluster, ctx: BriefContext): string {
  const { resolved, attempt, maxAttempts, priorAttempts } = ctx;
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
  lines.push("Read every one of these images with the Read tool before you edit anything.", "");
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
    "3. Follow this repository's own conventions. Read its CLAUDE.md and match the",
    "   surrounding code before adding anything new.",
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
  "For each cluster below, spawn ONE separate subagent whose entire prompt is: " +
    "\"Read <brief> and execute it fully. Reply with only the JSON it asks for.\" " +
    "Keeping the brief out of your own context is the point: you hold ids and verdicts, " +
    "the subagent holds the screenshots.",
  "Clusters touching different targets or routes can run in parallel. Clusters that " +
    "share a route must run one at a time, or the fix sessions will collide in the same files.",
  "When a subagent replies, run its cluster's verify command, passing what it reported: " +
    "`lookout verify-fix --cluster <id> --commit <sha> --note \"<rootCause>\"`.",
  "Branch on the verify exit code: 0 the fix is confirmed and the backlog is already " +
    "adjudicated, so move on. 1 it is not fixed and a fresh brief has been written, so " +
    "spawn a NEW subagent on that same brief path. 2 lookout failed to run. 3 the cluster " +
    "is blocked after exhausting its attempts, so stop dispatching it and report it.",
  "Never mark a finding fixed yourself, and never let a fix session verify its own work. " +
    "lookout is the only thing that rules on whether a defect is gone.",
];
