import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalShotId,
  canonicalShotRelPath,
  legacyRouteSlug,
  legacyShotId,
} from "../capture/route-identity.js";
import { lookoutDir } from "../config.js";
import { clusterKeyOf, legacyClusterKeyOf } from "../fix/cluster.js";
import type { ClusterState } from "../fix/state.js";
import type { FrameSet } from "../issues/frames.js";
import type { RegressionSet } from "../skills/regression.js";
import type { CaptureReport, ResolvedConfig } from "../types.js";
import { fingerprintOf, legacyFingerprintOf } from "./fingerprint.js";
import type { Backlog, BacklogFinding, EvidenceRef } from "./lib.js";
import { atomicWriteJson } from "../state/atomic.js";

function routeGroups(
  resolved: ResolvedConfig,
  backlog: Backlog,
  report: CaptureReport | null,
): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  const targets = Array.isArray(resolved.config.targets) ? resolved.config.targets : [];
  for (const target of targets) {
    for (const raw of target.routes?.length ? target.routes : ["/"]) {
      const route = typeof raw === "string" ? raw : raw.path;
      const normalized = route.startsWith("/") ? route : `/${route}`;
      const key = `${target.name}\u0000${legacyRouteSlug(normalized)}`;
      const routes = groups.get(key) ?? new Set<string>();
      routes.add(normalized);
      groups.set(key, routes);
    }
  }
  for (const finding of Object.values(backlog.findings)) {
    if (finding.channel === "code" || typeof finding.route !== "string" || typeof finding.target !== "string") continue;
    for (const value of [finding.route, ...(finding.seenRoutes ?? [])]) {
      const route = value.startsWith("/") ? value : `/${value}`;
      const key = `${finding.target}\u0000${legacyRouteSlug(route)}`;
      const routes = groups.get(key) ?? new Set<string>();
      routes.add(route);
      groups.set(key, routes);
    }
  }
  for (const shot of report?.shots ?? []) {
    const key = `${shot.target}\u0000${legacyRouteSlug(shot.route)}`;
    const routes = groups.get(key) ?? new Set<string>();
    routes.add(shot.route);
    groups.set(key, routes);
  }
  return groups;
}

interface ShotTranslation {
  id: string;
  path: string;
}

/** null means ambiguous, undefined means this id is not a legacy route id. */
function translateShot(
  id: string,
  groups: Map<string, Set<string>>,
): ShotTranslation | null | undefined {
  const [platform, target, token, state, formFactor, scheme, ...extra] = id.split("/");
  if (!platform || !target || !token || !state || !formFactor || !scheme || extra.length > 0) return undefined;
  const routes = groups.get(`${target}\u0000${token}`);
  if (!routes || routes.size === 0) return undefined;
  if (routes.size > 1) return null;
  const route = [...routes][0]!;
  const axes = {
    platform: platform as BacklogFinding["platform"],
    target,
    route,
    state,
    formFactor: formFactor as BacklogFinding["formFactor"],
    scheme: scheme as BacklogFinding["scheme"],
  } as Parameters<typeof canonicalShotId>[0];
  return { id: canonicalShotId(axes), path: canonicalShotRelPath(axes) };
}

function translateShotId(id: string, groups: Map<string, Set<string>>): string | null | undefined {
  const translated = translateShot(id, groups);
  return translated === null ? null : translated?.id;
}

function canonicalFingerprint(f: BacklogFinding): string {
  if (f.channel === "code") return f.fingerprint;
  return f.fingerprint === legacyFingerprintOf(f) ? fingerprintOf(f) : f.fingerprint;
}

function translateEvidence(
  f: BacklogFinding,
  ev: EvidenceRef,
  report: CaptureReport | null,
  groups: Map<string, Set<string>>,
): EvidenceRef | null {
  const generic = translateShot(ev.shotId, groups);
  if (generic === null) return null;
  if (generic && generic.id !== ev.shotId) {
    return { ...ev, shotId: generic.id, path: generic.path };
  }
  const route = f.route.startsWith("/") ? f.route : `/${f.route}`;
  const axes = {
    target: f.target,
    route,
    state: f.state,
    platform: f.platform!,
    formFactor: f.formFactor!,
    scheme: f.scheme!,
  };
  const key = `${f.target}\u0000${legacyRouteSlug(route)}`;
  if (ev.shotId === legacyShotId(axes) && (groups.get(key)?.size ?? 0) > 1) return null;

  const reportCandidates = (report?.shots ?? []).filter((shot) => legacyShotId(shot) === ev.shotId);
  const candidateRoutes = new Set(reportCandidates.map((shot) => shot.route));
  if (candidateRoutes.size > 1) return null;
  const reportShot = reportCandidates[0];
  if (reportShot) return { ...ev, shotId: reportShot.id, path: reportShot.path };
  if (ev.shotId !== legacyShotId(axes)) return ev;
  return { ...ev, shotId: canonicalShotId(axes), path: canonicalShotRelPath(axes) };
}

async function rewriteJson<T>(path: string, mutate: (value: T) => boolean): Promise<boolean> {
  if (!existsSync(path)) return false;
  let value: T;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return false;
  }
  if (!mutate(value)) return false;
  await atomicWriteJson(path, value);
  return true;
}

/** Migrate route-derived durable ids while retaining adjudication history. */
export async function migrateBacklogRouteIdentity(
  resolved: ResolvedConfig,
  backlog: Backlog,
  report: CaptureReport | null,
): Promise<boolean> {
  if (backlog.routeIdentity === 2) return false;
  const groups = routeGroups(resolved, backlog, report);
  const translations = new Map<string, string>();
  const invalid = new Set<string>();
  const issueKeys = new Map<string, Set<string>>();
  const fingerprintTranslations = new Map<string, string>();
  const nextFindings: Record<string, BacklogFinding> = {};
  let changed = false;

  for (const [storedKey, f] of Object.entries(backlog.findings)) {
    if (
      typeof f.fingerprint !== "string" ||
      typeof f.target !== "string" ||
      typeof f.route !== "string" ||
      typeof f.state !== "string" ||
      typeof f.category !== "string" ||
      typeof f.attribute !== "string" ||
      typeof f.channel !== "string"
    ) {
      nextFindings[storedKey] = f;
      continue;
    }
    const oldCluster = legacyClusterKeyOf(f);
    const nextFingerprint = canonicalFingerprint(f);
    const nextEvidence: EvidenceRef[] = [];
    for (const ev of f.evidence ?? []) {
      const migrated = translateEvidence(f, ev, report, groups);
      if (!migrated) {
        invalid.add(ev.shotId);
        changed = true;
        continue;
      }
      if (migrated.shotId !== ev.shotId) translations.set(ev.shotId, migrated.shotId);
      if (migrated.shotId !== ev.shotId || migrated.path !== ev.path) changed = true;
      nextEvidence.push(migrated);
    }
    const next = { ...f, fingerprint: nextFingerprint, evidence: nextEvidence };
    if (nextFingerprint !== f.fingerprint) {
      fingerprintTranslations.set(f.fingerprint, nextFingerprint);
      changed = true;
    }
    nextFindings[storedKey === f.fingerprint ? nextFingerprint : storedKey] = next;
    const nextCluster = clusterKeyOf(next);
    const successors = issueKeys.get(oldCluster) ?? new Set<string>();
    successors.add(nextCluster);
    issueKeys.set(oldCluster, successors);
  }
  backlog.findings = nextFindings;

  for (const issue of Object.values(backlog.issues)) {
    const successors = issueKeys.get(issue.key);
    if (!successors || successors.size === 0) continue;
    // A legacy accessibility locus can split when formerly colliding routes
    // become distinct. The lexicographically first successor retains the
    // original id and its history; reconciliation mints ids for the others.
    const next = [...successors].sort()[0]!;
    if (next === issue.key) continue;
    issue.priorKeys = [...new Set([...(issue.priorKeys ?? []), issue.key])];
    issue.key = next;
    changed = true;
  }

  for (const issue of Object.values(backlog.issues)) {
    for (const criterion of issue.acceptance ?? []) {
      if (criterion.from && fingerprintTranslations.has(criterion.from)) {
        criterion.from = fingerprintTranslations.get(criterion.from)!;
        changed = true;
      }
      if (!criterion.evidence) continue;
      const evidence: string[] = [];
      for (const id of criterion.evidence) {
        const translated = translateShotId(id, groups);
        if (translated === null) {
          changed = true;
          continue;
        }
        evidence.push(translated ?? id);
        if (translated && translated !== id) changed = true;
      }
      criterion.evidence = evidence;
    }
  }

  backlog.routeIdentity = 2;
  changed = true;
  const issuesRoot = join(lookoutDir(resolved), "issues");
  for (const issueId of Object.keys(backlog.issues)) {
    await rewriteJson<FrameSet>(join(issuesRoot, issueId, "frames.json"), (frames) => {
      let dirty = false;
      for (const frame of [...(frames.before ?? []), ...(frames.after ?? [])]) {
        if (!frame.shotId) continue;
        const translated = translateShotId(frame.shotId, groups);
        if (invalid.has(frame.shotId) || translated === null) {
          delete frame.shotId;
          delete frame.hash;
          dirty = true;
        } else if (translated || translations.has(frame.shotId)) {
          frame.shotId = translated ?? translations.get(frame.shotId)!;
          dirty = true;
        }
      }
      return dirty;
    });
    await rewriteJson<ClusterState>(join(issuesRoot, issueId, "state.json"), (state) => {
      let dirty = false;
      if (state.baseline?.hashes) {
        const hashes: Record<string, string> = {};
        for (const [id, hash] of Object.entries(state.baseline.hashes)) {
          const translated = translateShotId(id, groups);
          if (invalid.has(id) || translated === null) {
            dirty = true;
            continue;
          }
          const next = translated ?? translations.get(id) ?? id;
          if (next !== id) dirty = true;
          hashes[next] = String(hash);
        }
        state.baseline.hashes = hashes;
      }
      for (const attempt of state.attempts ?? []) {
        for (const row of [...(attempt.moved ?? []), ...(attempt.stillOpen ?? [])]) {
          const translated = row.shotId ? translateShotId(row.shotId, groups) : undefined;
          if (row.shotId && (invalid.has(row.shotId) || translated === null)) {
            row.shotId = "";
            dirty = true;
          } else if (row.shotId && (translated || translations.has(row.shotId))) {
            row.shotId = translated ?? translations.get(row.shotId)!;
            dirty = true;
          }
        }
      }
      return dirty;
    });
  }
  await rewriteJson<RegressionSet>(join(lookoutDir(resolved), "regression", "manifest.json"), (set) => {
    const before = set.cases ?? [];
    const cases = before
      .filter((entry) => !invalid.has(entry.shotId) && translateShotId(entry.shotId, groups) !== null)
      .map((entry) => ({
        ...entry,
        shotId: translateShotId(entry.shotId, groups) ?? translations.get(entry.shotId) ?? entry.shotId,
      }));
    const dirty = cases.length !== before.length || cases.some((entry, i) => entry.shotId !== before[i]?.shotId);
    if (dirty) set.cases = cases;
    return dirty;
  });

  await rm(join(lookoutDir(resolved), "ledger.json"), { force: true });
  return changed;
}
