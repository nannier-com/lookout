/**
 * The frozen set: past screenshots whose verdicts are already settled.
 *
 * lookout amends its own instructions automatically, which means the session
 * making the change is also the one that would grade it. Its own first rule
 * forbids exactly that, so the grading is handed to evidence nobody can argue
 * with: a curated set of screenshots, frozen as files, each carrying claims
 * that were adjudicated when the pixels were fresh.
 *
 *   must not file  a person read this finding and ruled it intentional. An
 *                  amendment that brings it back has widened the judge's net
 *                  past what this project accepts.
 *   must file      the adversarial verifier confirmed this defect on these
 *                  pixels. An amendment that loses it has blinded the judge.
 *
 * A candidate amendment is replayed over the frozen set before it takes effect.
 * Regress either way and it is rolled back, with the attempt written down.
 *
 * This file is the set: what goes into it, and how it is rebuilt. How a replay
 * is graded against it lives in verdict.ts, which carries the argument about
 * what a claim's identity actually is.
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir, lookoutDir } from "../config.js";
import { configuredScope, type ScopeCheck } from "../config-scope.js";
import { flatShotName } from "../issues/paths.js";
import { wasPhotographed, type Backlog, type BacklogFinding } from "../backlog/lib.js";
import { panelOf } from "../judge/panels.js";
import type {
  DeterministicFinding,
  FormFactor,
  PlatformKind,
  ResolvedConfig,
  Scheme,
  ShotRecord,
} from "../types.js";
import { atomicWriteJson } from "../state/atomic.js";

/** Mirrors the acceptance verifier's cap: one judgement, one context. */
export const MAX_FROZEN_SHOTS = 20;

export interface RegressionClaim {
  category: string;
  attribute: string;
  /**
   * The panel that owns the category, stamped at freeze time. The gate decides
   * a mustFile claim at this granularity (verdict.ts), so the committed
   * manifest says so rather than leaving a reader to derive it. Optional
   * because manifests frozen before the field exists still grade.
   */
  panel?: string;
  /** Why this claim stands: a human's reason, or the verifier's confirmation. */
  why: string;
}

export interface RegressionCase {
  shotId: string;
  /** Filename under regression/shots/. */
  file: string;
  target: string;
  route: string;
  routeName: string;
  state: string;
  formFactor: FormFactor;
  scheme: Scheme;
  platform: PlatformKind;
  width: number;
  height: number;
  /**
   * What lookout measured on this shot, and what scrolls in it.
   *
   * Carried because the refuter's prompt carries them in production, and a
   * gate that grades an amendment under different evidence than the run it is
   * grading is not grading that run. Optional: sets frozen before this field
   * existed still replay, with the evidence they were frozen with.
   */
  deterministicFindings?: DeterministicFinding[];
  scrollers?: ShotRecord["scrollers"];
  /** True when the shot's provenance sidecar was copied beside it. */
  provenance?: boolean;
  /**
   * True when the shot's accessibility-tree sidecar was copied beside it.
   *
   * Same argument as the findings above, and it applies harder: the integrity
   * and text panels are GIVEN the tree in production, so a replay without it
   * grades those two under evidence they never actually judge on.
   */
  aria?: boolean;
  mustNotFile: RegressionClaim[];
  mustFile: RegressionClaim[];
}

export interface RegressionSet {
  note: string;
  frozenAt: string;
  cases: RegressionCase[];
}

const NOTE =
  "lookout's frozen regression set. These screenshots and their settled verdicts gate every " +
  "automatic amendment to a skill: an amendment that re-files something adjudicated by-design, " +
  "or loses a confirmed defect, is rolled back. The manifest is committed; the shots are " +
  "rebuilt from the capture workspace by `lookout skills freeze`, and without them nothing is " +
  "applied automatically.";

export function regressionDir(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "regression");
}

export function regressionManifestPath(resolved: ResolvedConfig): string {
  return join(regressionDir(resolved), "manifest.json");
}

export async function loadRegressionSet(resolved: ResolvedConfig): Promise<RegressionSet | null> {
  const p = regressionManifestPath(resolved);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, "utf8")) as RegressionSet;
}

/**
 * Can this set actually grade anything right now?
 *
 * The manifest is committed and the pixels are not, so a fresh clone has the
 * claims but not the evidence for them. That is a gate that cannot run, and a
 * gate that cannot run must never be mistaken for one that passed.
 */
export function usableCases(resolved: ResolvedConfig, set: RegressionSet): RegressionCase[] {
  const dir = join(regressionDir(resolved), "shots");
  return set.cases.filter((c) => existsSync(join(dir, c.file)));
}

/**
 * Which claims a backlog can settle, keyed by the screenshot that proves them.
 * Pure, so the selection can be argued with without touching disk: `inScope`
 * is the config's reach handed in rather than read here.
 */
export function claimsByShot(
  backlog: Backlog,
  inScope: ScopeCheck,
): Map<string, { case: Omit<RegressionCase, "file" | "width" | "height">; path: string }> {
  const out = new Map<string, { case: Omit<RegressionCase, "file" | "width" | "height">; path: string }>();

  const add = (f: BacklogFinding, kind: "mustNotFile" | "mustFile", why: string): void => {
    const ev = f.evidence[f.evidence.length - 1];
    if (!ev) return;
    // The frozen set is screenshots, replayed through the visual judge, so a
    // claim has to be about something that judge would file. The other two
    // channels have no place here: a code finding was read out of the source
    // and cannot be re-judged from pixels, and a deterministic finding is a
    // measurement the replay never re-takes and the rubric forbids the judge
    // to restate. Freezing either would put a claim in the gate that every
    // replay is bound to get "wrong": a mustFile no judge is allowed to
    // satisfy, or a mustNotFile about a verdict the judge was never party to.
    if (f.channel !== "ai") return;
    // Always true of an AI finding; the guard is what gives the case its axes.
    if (!wasPhotographed(f)) return;
    // And it has to be about a screen this project still asks for. The backlog
    // outlives the config that produced it, so a route or a state deleted from
    // `lookout.config.ts` leaves settled findings behind. Their verdicts were
    // real, but the cap here is on SCREENSHOTS: a claim about a screen the app
    // no longer serves takes one of twenty slots away from a live one, and no
    // later run will ever re-adjudicate it, because `check` stopped looking at
    // that route. Evidence still on disk is not the test. `capture` prunes such
    // shots from the report and deliberately leaves the PNGs, since backlog
    // findings still point at them, so file existence would let exactly the
    // findings this rejects back in.
    if (!inScope(f)) return;
    let entry = out.get(ev.shotId);
    if (!entry) {
      entry = {
        path: ev.path,
        case: {
          shotId: ev.shotId,
          target: f.target,
          route: f.route,
          routeName: f.route,
          state: f.state,
          formFactor: f.formFactor,
          scheme: f.scheme,
          platform: f.platform,
          mustNotFile: [],
          mustFile: [],
        },
      };
      out.set(ev.shotId, entry);
    }
    if (entry.case[kind].some((c) => c.category === f.category && c.attribute === f.attribute)) return;
    entry.case[kind].push({
      category: f.category,
      attribute: f.attribute,
      panel: panelOf(f.category).name,
      why,
    });
  };

  for (const f of Object.values(backlog.findings)) {
    if (f.status === "by-design" && f.reason) {
      add(f, "mustNotFile", f.reason);
    } else if (f.verified && f.severity !== "low" && f.category !== "design-parity") {
      // Everything the refuter confirms except lows. Since the refuting pass
      // reaches every severity, a confirmed medium is a claim the set can
      // hold; lows stay out because they are the most judge-variant and the
      // least costly to miss, and a gate that fails amendments on replay
      // misses cannot afford flaky claims about the cheapest findings.
      // design-parity stays out too: a frozen case carries no design
      // reference, so no replay could ever re-file the divergence, and an
      // unsatisfiable mustFile would report every future amendment as losing
      // it. (Replay scoping also refuses to grade such claims; this keeps
      // them out of the set at the source.)
      add(f, "mustFile", `confirmed by the adversarial verifier: ${f.title}`);
    }
  }
  return out;
}

/**
 * Freeze the settled claims into a set that survives an evidence clean.
 *
 * Shots carrying the most claims come first: the cap is on screenshots, and the
 * gate is stronger the more it can decide per image.
 *
 * `outOfScope` is how many settled screenshots the current config no longer
 * reaches. It is reported rather than persisted, because a set that comes back
 * empty for that reason needs a different answer from one that is empty because
 * nothing has been adjudicated.
 *
 * Selection is by shot and not by view group, which means a six-shot group can
 * come through as one. That matters for the two categories the rubric defines
 * as comparisons (responsive is "a smaller form factor losing content the
 * LARGER ONE has"; colour-scheme is about what happens "after a scheme
 * switch"), and it is tempting to drop such a claim here when its comparison
 * is not frozen alongside it. Deliberately not done: both categories also list
 * single-shot cases the judge can still file from one image, so dropping the
 * claim would delete settled evidence on an inference. A claim the current
 * skills genuinely cannot reproduce is caught by measurement instead, in the
 * gate's control round (gate.ts), which reports it as stale without deleting
 * anything from the committed record.
 */
export async function freezeRegressionSet(
  resolved: ResolvedConfig,
  backlog: Backlog,
  now: string,
  max = MAX_FROZEN_SHOTS,
): Promise<{ set: RegressionSet; outOfScope: number }> {
  const evDir = evidenceDir(resolved);
  const dir = regressionDir(resolved);
  await mkdir(join(dir, "shots"), { recursive: true });

  // The capture report, for what was MEASURED on each frozen shot. The claims
  // come from the backlog, which records what was judged and never how the
  // page was built, and the refuter reads both in production.
  const { loadReport } = await import("../capture/store.js");
  const report = await loadReport(resolved);
  const measured = new Map((report?.shots ?? []).map((sh) => [sh.id, sh]));

  const scoped = claimsByShot(backlog, await configuredScope(resolved));
  const outOfScope = claimsByShot(backlog, () => true).size - scoped.size;
  const candidates = [...scoped.values()].sort(
    (a, b) =>
      b.case.mustNotFile.length + b.case.mustFile.length -
        (a.case.mustNotFile.length + a.case.mustFile.length) ||
      a.case.shotId.localeCompare(b.case.shotId),
  );

  const cases: RegressionCase[] = [];
  for (const candidate of candidates) {
    if (cases.length >= max) break;
    const src = join(evDir, candidate.path);
    if (!existsSync(src)) continue;
    const file = flatShotName(candidate.path);
    await copyFile(src, join(dir, "shots", file));
    // The sidecar beside it, when there is one: the refuter reads it in
    // production, so a replay without it is answering a different question.
    // Best effort, exactly like the sidecar's own capture: a case that cannot
    // carry one still grades everything else.
    const copySidecar = async (suffix: string): Promise<boolean> => {
      if (!existsSync(`${src}.${suffix}`)) return false;
      try {
        await copyFile(`${src}.${suffix}`, join(dir, "shots", `${file}.${suffix}`));
        return true;
      } catch {
        return false;
      }
    };
    const provenance = await copySidecar("provenance.json");
    const aria = await copySidecar("aria.json");
    const size = statSync(src).size;
    const shot = measured.get(candidate.case.shotId);
    cases.push({
      ...candidate.case,
      file,
      ...(provenance ? { provenance } : {}),
      ...(aria ? { aria } : {}),
      ...(shot?.deterministicFindings.length ? { deterministicFindings: shot.deterministicFindings } : {}),
      ...(shot?.scrollers?.length ? { scrollers: shot.scrollers } : {}),
      // Dimensions are only ever printed in the manifest the judge reads; the
      // bytes are what it actually looks at.
      width: 0,
      height: size,
    });
  }

  const set: RegressionSet = { note: NOTE, frozenAt: now, cases };
  const p = regressionManifestPath(resolved);
  await atomicWriteJson(p, set);
  return { set, outOfScope };
}

/** The frozen cases as shots the judge can be pointed at. */
export function casesAsShots(set: RegressionSet, runId = "regression"): ShotRecord[] {
  return set.cases.map((c) => ({
    id: c.shotId,
    target: c.target,
    route: c.route,
    routeName: c.routeName,
    state: c.state,
    platform: c.platform,
    formFactor: c.formFactor,
    scheme: c.scheme,
    path: join("shots", c.file),
    hash: c.file,
    bytes: c.height,
    width: c.width,
    height: c.height,
    animated: false,
    ...(c.scrollers ? { scrollers: c.scrollers } : {}),
    // The sidecar sits beside the copied PNG under the same name, which is the
    // convention loadSidecarBeside reads.
    ...(c.provenance ? { provenance: `${join("shots", c.file)}.provenance.json` } : {}),
    ...(c.aria ? { aria: `${join("shots", c.file)}.aria.json` } : {}),
    capturedAt: set.frozenAt,
    runId,
    deterministicFindings: c.deterministicFindings ?? [],
  }));
}
