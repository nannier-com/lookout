/**
 * What lookout has learned about its own judgement, from what is already on
 * disk.
 *
 * Nothing here is new instrumentation. Every one of these signals is a record
 * lookout already keeps for another reason, and each is a case where its
 * instructions and its judgement came apart:
 *
 * - A refuted finding is one the judge filed and the adversarial verifier
 *   killed. The verifier's note says why, and that note is a rule the judge
 *   should have been following.
 * - A rejected finding is one whose category or severity was not in the
 *   vocabulary. That is the output contract failing to land.
 * - A by-design adjudication is the strongest signal in the system: a person
 *   read the finding, decided it was intended, and wrote down why. It is the
 *   only one carrying human judgement, and `config.neverFile` exists precisely
 *   because this used to be fed back by hand.
 * - A blocked issue is a defect that survived every attempt, which usually
 *   means the finding described it too vaguely to act on.
 * - A criterion ruled not-verifiable is an acceptance criterion written so it
 *   cannot be decided from a screenshot, which is a flaw in how it was authored.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { loadBacklog } from "../verbs/backlog.js";
import { issuesOf } from "../issues/registry.js";
import { sha256 } from "../util.js";
import type { ResolvedConfig } from "../types.js";

export interface Signal {
  /** Which skill this is evidence about. */
  skill: string;
  /**
   * Extra skills this signal licenses an amendment to, beyond `skill` and the
   * pair rule: a refuter lesson names the panel whose finding it overruled.
   * Never part of the watermark key, like `skill` itself.
   */
  licenses?: string[];
  kind: "refuted" | "rejected" | "by-design" | "blocked" | "not-verifiable";
  /** One line naming what happened. */
  summary: string;
  /** The prose that explains it: a verifier note, a human reason, a judge note. */
  detail: string;
  /** Where it came from, so an amendment can cite it. */
  source: string;
  /**
   * Stable identity, for the watermark: the same underlying event recomputes
   * to the same key on every gather, so "new since the last improve" is
   * decidable. Excludes `skill` on purpose: attribution fixes must never
   * resurrect already-consumed evidence.
   */
  key: string;
}

/** kind|stable-source, hashed short. What "stable" means varies per kind. */
function keyOf(kind: Signal["kind"], stable: string): string {
  return sha256(new TextEncoder().encode(`${kind}|${stable}`)).slice(0, 16);
}

interface JudgeReport {
  runId?: string;
  refuted?: { title: string; shotId: string; verifierNote: string }[];
  rejected?: number;
}

export async function gatherSignals(resolved: ResolvedConfig): Promise<Signal[]> {
  const signals: Signal[] = [];
  const backlog = await loadBacklog(resolved);

  const reportPath = join(evidenceDir(resolved), "judge-report.json");
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as JudgeReport;
      for (const r of report.refuted ?? []) {
        signals.push({
          skill: "visual-judge",
          kind: "refuted",
          summary: `filed and refuted: ${r.title}`,
          detail: r.verifierNote,
          source: `judge-report.json (${r.shotId})`,
          // shotId+title: the report is overwritten per run, so the id alone
          // would merge distinct refutations of one view across runs.
          key: keyOf("refuted", `${r.shotId}|${r.title}`),
        });
      }
      if (report.rejected && report.rejected > 0) {
        signals.push({
          skill: "visual-judge",
          kind: "rejected",
          summary: `${report.rejected} finding(s) rejected at ingestion`,
          detail:
            "The category or severity was outside the closed vocabulary, so the finding was " +
            "discarded. The output contract is not landing.",
          source: `judge-report.json (run ${report.runId ?? "?"})`,
          // Keyed by run on purpose: a contract that keeps failing to land is
          // fresh evidence each time it does.
          key: keyOf("rejected", report.runId ?? "unknown-run"),
        });
      }
    } catch {
      // A report that cannot be parsed teaches nothing; it is not an error here.
    }
  }

  for (const finding of Object.values(backlog.findings)) {
    if (finding.status !== "by-design" || !finding.reason) continue;
    // A ruling only teaches the skill that made the claim. A deterministic
    // finding is a measurement, born `verified: true` because the check is its
    // own evidence; the refuter never sees that channel, so reading the flag
    // as the refuter's confirmation misattributes the lesson (the same fact
    // keeps non-AI channels out of the frozen regression claims). A person
    // ruling a measurement intentional is setting the project's tolerance for
    // a deterministic check, which no amendable skill controls, so it emits
    // nothing. Code findings split by author: a skill-found hand-roll is the
    // conformance skill's own claim, so overruling it is that skill's lesson;
    // a scanner-found one is a measurement too. Absent provenance predates
    // the skill and stays out, the opposite of the fix ruling's reading of
    // absence: keeping a defect open errs safe, amending a skill off another
    // oracle's claim does not.
    if (finding.channel === "code") {
      if (finding.source?.foundBy !== "skill") continue;
      signals.push({
        skill: "kit-conformance",
        kind: "by-design",
        summary: `adjudicated intentional: ${finding.title}`,
        detail: finding.reason,
        source: finding.fingerprint,
        key: keyOf("by-design", finding.fingerprint),
      });
      continue;
    }
    if (finding.channel !== "ai") continue;
    // A verified finding ruled intentional is a human overruling the
    // adversarial verifier's explicit confirmation: the refuter's whole
    // mandate was to kill it, so the lesson is the refuter's. An
    // unverified one is the judge's error alone.
    const overruledVerifier = finding.verified === true;
    signals.push({
      skill: overruledVerifier ? "refute-finding" : "visual-judge",
      kind: "by-design",
      summary: `adjudicated intentional: ${finding.title}`,
      detail: overruledVerifier
        ? `${finding.reason} (the adversarial verifier had confirmed this finding; a person then ruled it intentional)`
        : finding.reason,
      source: finding.fingerprint,
      key: keyOf("by-design", finding.fingerprint),
    });
  }

  for (const issue of issuesOf(backlog)) {
    if (issue.members.some((m) => m.status === "blocked")) {
      const reason = issue.members.find((m) => m.status === "blocked")?.reason ?? "";
      signals.push({
        skill: "visual-judge",
        kind: "blocked",
        summary: `survived every attempt: ${issue.title}`,
        detail: reason,
        source: `issue ${issue.id}`,
        key: keyOf("blocked", issue.id),
      });
    }
    for (const c of backlog.issues?.[issue.id]?.acceptance ?? []) {
      if (c.verdict !== "not-verifiable") continue;
      // By author: a judge-sourced criterion was WRITTEN by the visual judge,
      // so an undecidable one is the judge's authoring lesson. Derived and
      // universal criteria are code-authored; their failures are incident
      // material, not skill-text material, and teach no skill anything.
      if (c.source !== "judge") continue;
      signals.push({
        skill: "visual-judge",
        kind: "not-verifiable",
        summary: `criterion could not be decided from the evidence: ${c.text}`,
        detail: c.note ?? "",
        source: `issue ${issue.id} (${c.id})`,
        key: keyOf("not-verifiable", `${issue.id}|${c.id}`),
      });
    }
  }

  // The standalone verify verb's report, which nothing read before: its
  // not-verifiable criteria are ticket-authored text the verify-acceptance
  // skill could learn to interpret, which makes them that skill's evidence.
  const verifyPath = join(evidenceDir(resolved), "verify-report.json");
  if (existsSync(verifyPath)) {
    try {
      const vr = JSON.parse(await readFile(verifyPath, "utf8")) as {
        criteriaSource?: string;
        criteria?: { id?: number; text?: string; verdict?: string; reasoning?: string }[];
      };
      for (const c of vr.criteria ?? []) {
        if (c.verdict !== "not-verifiable") continue;
        signals.push({
          skill: "verify-acceptance",
          kind: "not-verifiable",
          summary: `ticket criterion could not be decided from screenshots: ${c.text ?? ""}`,
          detail: c.reasoning ?? "",
          source: `verify-report.json (${vr.criteriaSource ?? "criteria"})`,
          key: keyOf("not-verifiable", `${vr.criteriaSource ?? "inline"}|${c.id ?? c.text ?? ""}`),
        });
      }
    } catch {
      // Same stance as the judge report: unparseable teaches nothing here.
    }
  }

  return signals;
}

/** Signals grouped by the skill they are evidence about, richest group first. */
export function bySkill(signals: Signal[]): Map<string, Signal[]> {
  const out = new Map<string, Signal[]>();
  for (const s of signals) {
    const arr = out.get(s.skill) ?? [];
    arr.push(s);
    out.set(s.skill, arr);
  }
  return new Map([...out.entries()].sort((a, b) => b[1].length - a[1].length));
}
