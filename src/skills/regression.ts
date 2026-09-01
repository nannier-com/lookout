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
 * Matching is by CATEGORY, not by attribute. The attribute is the judge's own
 * phrasing of an aspect and moves between runs on identical pixels; gating an
 * amendment on it would reject good ones for rewording. The category is the
 * closed vocabulary, and it is what a suppression or a confirmation was about.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir, lookoutDir } from "../config.js";
import { flatShotName } from "../issues/paths.js";
import { wasPhotographed, type Backlog, type BacklogFinding } from "../backlog/lib.js";
import type { AiFinding } from "../judge/engine.js";
import type { FormFactor, PlatformKind, ResolvedConfig, Scheme, ShotRecord } from "../types.js";

/** Mirrors the acceptance verifier's cap: one judgement, one context. */
export const MAX_FROZEN_SHOTS = 20;

export interface RegressionClaim {
  category: string;
  attribute: string;
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
 * Pure, so the selection can be argued with without touching disk.
 */
export function claimsByShot(backlog: Backlog): Map<string, { case: Omit<RegressionCase, "file" | "width" | "height">; path: string }> {
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
    entry.case[kind].push({ category: f.category, attribute: f.attribute, why });
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
 */
export async function freezeRegressionSet(
  resolved: ResolvedConfig,
  backlog: Backlog,
  now: string,
  max = MAX_FROZEN_SHOTS,
): Promise<RegressionSet> {
  const evDir = evidenceDir(resolved);
  const dir = regressionDir(resolved);
  await mkdir(join(dir, "shots"), { recursive: true });

  const candidates = [...claimsByShot(backlog).values()].sort(
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
    const size = statSync(src).size;
    cases.push({
      ...candidate.case,
      file,
      // Dimensions are only ever printed in the manifest the judge reads; the
      // bytes are what it actually looks at.
      width: 0,
      height: size,
    });
  }

  const set: RegressionSet = { note: NOTE, frozenAt: now, cases };
  const p = regressionManifestPath(resolved);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(set, null, 2));
  await rename(tmp, p);
  return set;
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
    capturedAt: set.frozenAt,
    runId,
    deterministicFindings: [],
  }));
}

export interface Violation {
  kind: "re-filed" | "lost";
  shotId: string;
  category: string;
  why: string;
}

/**
 * Did the candidate hold? Pure: given the settled claims and what the judge
 * said this time, name every way the two disagree.
 */
export function evaluateReplay(set: RegressionSet, findings: AiFinding[]): Violation[] {
  const byShot = new Map<string, Set<string>>();
  for (const f of findings) {
    const categories = byShot.get(f.shotId) ?? new Set<string>();
    categories.add(f.category);
    byShot.set(f.shotId, categories);
  }

  const violations: Violation[] = [];
  const seen = new Set<string>();
  const push = (v: Violation): void => {
    // Two by-design findings on one screenshot can share a category; one
    // re-filing is one violation, not two.
    const key = `${v.kind}|${v.shotId}|${v.category}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(v);
  };
  for (const c of set.cases) {
    const filed = byShot.get(c.shotId) ?? new Set<string>();
    for (const claim of c.mustNotFile) {
      if (filed.has(claim.category)) {
        push({ kind: "re-filed", shotId: c.shotId, category: claim.category, why: claim.why });
      }
    }
    for (const claim of c.mustFile) {
      if (!filed.has(claim.category)) {
        push({ kind: "lost", shotId: c.shotId, category: claim.category, why: claim.why });
      }
    }
  }
  return violations;
}
