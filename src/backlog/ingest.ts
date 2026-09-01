/**
 * Turning what the three channels produce into findings the backlog can hold.
 *
 * lookout finds defects three ways and they arrive in three shapes: a
 * deterministic check emits a typed record, the judge replies with prose and a
 * shot id, and the conformance reader names a component in a file. Each is
 * mapped here, and nowhere else, so the backlog only ever sees one shape and
 * the fingerprint means the same thing whichever channel produced it.
 */
import { fingerprintOf, sourceFingerprintOf } from "./fingerprint.js";
import { regionFromSelectors } from "./region.js";
import type { AiFinding } from "../judge/engine.js";
import type { HandRoll } from "../design/inventory.js";
import type { Category } from "../judge/rubric.js";
import type {
  CaptureReport,
  DeterministicFinding,
  FormFactor,
  PlatformKind,
  Scheme,
  Severity,
  ShotRecord,
} from "../types.js";
import type { BacklogFinding, Channel, SourceRef } from "./lib.js";

// Ingestion mappers

const DETERMINISTIC_MAP: Record<
  DeterministicFinding["type"],
  { category: Category; attribute: string }
> = {
  "console-error": { category: "render-failure", attribute: "console-error" },
  "page-error": { category: "render-failure", attribute: "page-error" },
  "request-failed": { category: "render-failure", attribute: "request-failed" },
  "horizontal-overflow": { category: "layout-overflow", attribute: "horizontal-scroll" },
  "axe-violation": { category: "a11y", attribute: "axe" },
  "blank-shot": { category: "render-failure", attribute: "blank" },
  "capture-error": { category: "render-failure", attribute: "capture-error" },
  "scheme-mismatch": { category: "color-scheme", attribute: "scheme-mechanism" },
  "stale-frame": { category: "render-failure", attribute: "stale-frame" },
  "off-origin": { category: "render-failure", attribute: "off-origin" },
  "dead-interaction": { category: "states", attribute: "dead-control" },
};

function severityFromDeterministic(f: DeterministicFinding): Severity {
  // Both mean the pixels are not the thing the shot claims to be, which makes
  // every other finding on that shot describe the wrong screen.
  if (f.type === "blank-shot" || f.type === "off-origin") return "critical";
  if (f.severity === "error") return "high";
  if (f.severity === "warning") return "medium";
  return "low";
}

/**
 * A finding that was photographed, and therefore carries the capture axes.
 *
 * Everything that renders a finding against a screenshot needs this: a
 * code-channel finding has no viewport, no scheme and no image, so a board
 * tile, a contact sheet entry or a frozen regression case cannot be built from
 * one. Narrowing through this guard is what makes that a compile-time fact
 * rather than a convention somebody has to remember.
 */
export type PhotographedFinding = BacklogFinding & {
  platform: PlatformKind;
  formFactor: FormFactor;
  scheme: Scheme;
};

export function wasPhotographed(f: BacklogFinding): f is PhotographedFinding {
  return f.formFactor !== undefined && f.scheme !== undefined && f.platform !== undefined;
}

/** Deterministic findings from a capture report, as backlog-shaped findings. */
export function deterministicToFindings(
  report: CaptureReport,
  opts: { shellIdentity?: boolean } = {},
): Omit<BacklogFinding, "firstSeen" | "lastSeen" | "status" | "reason" | "fixAttempts" | "fixedIn">[] {
  const out: ReturnType<typeof deterministicToFindings> = [];
  for (const shot of report.shots) {
    for (const df of shot.deterministicFindings) {
      const map = DETERMINISTIC_MAP[df.type];
      // axe findings keep their ruleId as the attribute so different rules
      // stay distinct findings.
      const attribute =
        df.type === "axe-violation" && df.meta && typeof df.meta.ruleId === "string"
          ? `axe-${df.meta.ruleId}`
          : map.attribute;
      // There is no judge on this channel, but axe reports the violating
      // nodes' selector paths, and a node literally inside <nav>, <header> or
      // <footer> is chrome by the only definition capture can check.
      const region =
        df.type === "axe-violation" && df.meta && Array.isArray(df.meta.targets)
          ? regionFromSelectors(
              (df.meta.targets as unknown[]).filter((t): t is string => typeof t === "string"),
              typeof df.meta.nodeCount === "number" ? df.meta.nodeCount : 0,
            )
          : undefined;
      out.push({
        fingerprint: fingerprintOf({
          ...shot,
          category: map.category,
          attribute,
          region: opts.shellIdentity ? region : undefined,
        }),
        target: shot.target,
        route: shot.route,
        state: shot.state,
        platform: shot.platform,
        formFactor: shot.formFactor,
        scheme: shot.scheme,
        region,
        category: map.category,
        attribute,
        severity: severityFromDeterministic(df),
        title: df.message.slice(0, 160),
        problem: df.message,
        expected: "",
        observed: "",
        channel: "deterministic",
        confidence: "high",
        verified: true,
        evidence: [{ shotId: shot.id, path: shot.path, hash: shot.hash, runId: shot.runId }],
      });
    }
  }
  return out;
}

/** AI findings (from a check run) joined with their shots. */
export function aiToFindings(
  findings: (AiFinding & { verified?: boolean })[],
  shotsById: Map<string, ShotRecord>,
  opts: {
    /**
     * The shellScoping transition flag. Off, the region is stored but identity
     * stays route-keyed, so records accumulate regions a person can inspect;
     * on, a shell region takes the route's slot in the fingerprint and the
     * merge folds the route-scoped history it supersedes.
     */
    shellIdentity?: boolean;
  } = {},
): ReturnType<typeof deterministicToFindings> {
  const out: ReturnType<typeof deterministicToFindings> = [];
  for (const f of findings) {
    const shot = shotsById.get(f.shotId);
    if (!shot) continue;
    out.push({
      fingerprint: fingerprintOf({
        ...shot,
        category: f.category,
        attribute: f.attribute,
        region: opts.shellIdentity ? f.region : undefined,
      }),
      target: shot.target,
      route: shot.route,
      state: shot.state,
      platform: shot.platform,
      formFactor: shot.formFactor,
      scheme: shot.scheme,
      region: f.region,
      category: f.category,
      attribute: f.attribute,
      severity: f.severity,
      title: f.title,
      problem: f.problem,
      expected: f.expected,
      observed: f.observed,
      channel: "ai",
      confidence: f.confidence,
      verified: !!f.verified,
      acceptance: f.acceptance ?? [],
      evidence: [{ shotId: shot.id, path: shot.path, hash: shot.hash, runId: shot.runId }],
    });
  }
  return out;
}

/**
 * Hand-rolled duplicates of kit components, as backlog-shaped findings.
 *
 * This is the code channel's only producer, and it is deliberately the only
 * kind of claim on it: a component the application built out of raw elements in
 * a project that has a design system providing the same thing. That is decidable
 * by reading the source, which is what makes it safe to file. lookout can rule
 * on it later by reading the source again, so `verify-fix` still closes it on
 * evidence rather than on the fixer's say-so.
 *
 * Severity is fixed at medium. A duplicated control is a real defect (it drifts
 * from the kit the moment either changes, and it is invisible to the kit's own
 * tests) and it is never an emergency, so ranking it against a broken render
 * would be false precision.
 */
export function handRollsToFindings(
  handRolls: HandRoll[],
  kitName: string,
  target: string,
): ReturnType<typeof deterministicToFindings> {
  return handRolls.map((h) => {
    const source: SourceRef = {
      path: h.path,
      relPath: h.relPath,
      symbol: h.symbol,
      line: h.line,
      foundBy: h.foundBy,
      ...(h.note ? { note: h.note } : {}),
    };
    const what = h.symbol ?? "A component";
    const raw = h.elements.length > 0 ? `raw <${h.elements.join(">, <")}> elements` : "raw elements";
    // Two defects wear the same shape, and conflating them sends the fix to the
    // wrong place. A duplicate has something in the kit to be replaced BY. A
    // gap has nothing, so the work is to add it to the kit and consume it, and
    // naming a component the kit does not export would send somebody hunting
    // for an import that never existed.
    const duplicate = h.candidate !== null;
    return {
      fingerprint: sourceFingerprintOf({
        target,
        source,
        category: "consistency",
        attribute: "hand-rolled",
      }),
      target,
      // "Where" for a source finding is the file, asked of a file rather than
      // of a screen.
      route: h.relPath,
      state: "source",
      source,
      category: "consistency" as Category,
      attribute: "hand-rolled",
      severity: "medium" as Severity,
      title: duplicate
        ? `${what} is hand-rolled where ${kitName} provides ${h.candidate}`
        : `${what} is hand-rolled out of raw elements beside ${kitName}`,
      problem:
        `${what} in ${h.relPath} is built from ${raw}, in a project that uses ` +
        `${kitName}. ` +
        (duplicate
          ? `${kitName} provides ${h.candidate} already. A hand-rolled copy drifts from the kit ` +
            `the moment either side changes, is invisible to the kit's own tests and ` +
            `docs, and hides whatever the kit is missing that made hand-rolling it ` +
            `seem necessary.`
          : `${kitName} does not appear to provide an equivalent, so this is a gap in the ` +
            `kit rather than a duplicate of it. Left in the application it is a control ` +
            `nobody else can reuse, held to none of the kit's rules, and the next screen ` +
            `that needs one will build a third version of it.`) +
        (h.note ? ` ${h.note}` : ""),
      expected: duplicate
        ? `The control is composed from ${kitName}. If ${kitName} does not cover this ` +
          `case, the gap is filled IN ${kitName}, backwards-compatibly, and consumed ` +
          `from there.`
        : `The control is added to ${kitName} backwards-compatibly and consumed from ` +
          `there, rather than living as raw elements in the application.`,
      observed:
        h.foundBy === "skill"
          ? `Read in the source at ${h.relPath}:${h.line}, built from ${raw}.`
          : `Built from raw elements at ${h.relPath}:${h.line}, with no ${kitName} import in the file.`,
      channel: "code" as Channel,
      // Read out of the source rather than inferred: either the file imports
      // the kit or it does not.
      confidence: "high" as const,
      // Nothing adversarially verifies a code finding; the scanner IS the
      // evidence, and it is re-run to rule on the fix.
      verified: false,
      acceptance: duplicate
        ? [
            `${what} in ${h.relPath} is composed from ${kitName} components, or the file no longer declares it.`,
            `No raw-element control named ${what} remains in that file.`,
          ]
        : [
            `${what} is provided by ${kitName} and consumed from there, or the file no longer declares it.`,
            `No raw-element control named ${what} remains in ${h.relPath}.`,
          ],
      // No screenshot: this was read, not photographed.
      evidence: [],
    };
  });
}
