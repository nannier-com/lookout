/**
 * When a map is still a fact about the source, and when it has gone stale.
 *
 * A map is derived from four things: the skill that asked for it, the routes
 * the config seeds it with, the route-bearing files the scan offered, and the
 * content of the files the reader opened. Any of those moving is a reason to
 * scan again; nothing else is. The model that read is recorded for people and
 * left out of the signature on purpose: a map is a fact about the source,
 * not a verdict, and keying it on the model would re-scan the same tree every
 * time somebody picked a different judge.
 */
import { hashText } from "../design/conformance-cache.js";
import type { MapCandidate } from "./candidates.js";
import type { MapTarget } from "./store.js";

export interface ConfigSlice {
  url: string;
  routes: { path: string; states: string[] }[];
}

export interface SignatureInput {
  skill: { version: number; text: string };
  configSlice: ConfigSlice;
  /** Repo-relative, sorted. */
  candidatePaths: string[];
  /** Repo-relative, sorted, with content hashes. */
  examined: { path: string; hash: string }[];
}

export function skillHash(skill: { version: number; text: string }): string {
  return hashText(`v${skill.version}|p:${hashText(skill.text)}`);
}

export function configHash(slice: ConfigSlice): string {
  return hashText(JSON.stringify({ url: slice.url, routes: slice.routes.map((r) => ({ path: r.path, states: [...r.states] })) }));
}

export function examinedHash(examined: readonly { path: string; hash: string }[]): string {
  return hashText([...examined].sort((a, b) => a.path.localeCompare(b.path)).map((e) => `${e.path}:${e.hash}`).join("\n"));
}

export function candidatesHash(paths: readonly string[]): string {
  return hashText([...paths].sort().join("\n"));
}

export function mapSignature(input: SignatureInput): string {
  return hashText(
    [skillHash(input.skill), configHash(input.configSlice), candidatesHash(input.candidatePaths), examinedHash(input.examined)].join("|"),
  );
}

export interface Freshness {
  fresh: boolean;
  /** What moved, in the words the verb prints; empty when fresh. */
  reasons: string[];
}

/**
 * Whether a stored map still describes the source. Each input is compared
 * apart so the reason can be named, and the composite decides.
 */
export function mapFreshness(args: {
  target: MapTarget | undefined;
  targetName: string;
  skill: { version: number; text: string };
  configSlice: ConfigSlice;
  candidates: readonly MapCandidate[];
  /** The current content hash of a repo-relative path, or null when it is gone. */
  hashOf: (relPath: string) => string | null;
}): Freshness {
  const { target } = args;
  if (!target) return { fresh: false, reasons: [`no map for ${args.targetName}`] };
  const reasons: string[] = [];

  if (target.skillVersion !== args.skill.version) {
    reasons.push(`map-screens v${target.skillVersion} -> v${args.skill.version}`);
  } else if (target.skillHash !== undefined && target.skillHash !== skillHash(args.skill)) {
    reasons.push("the map-screens skill changed");
  }
  if (target.configHash !== undefined && target.configHash !== configHash(args.configSlice)) {
    reasons.push("configured routes changed");
  }
  const candidatePaths = args.candidates.map((c) => c.relPath).sort();
  if (target.candidates !== undefined) {
    const before = new Set(target.candidates);
    const after = new Set(candidatePaths);
    const moved = [...before].filter((p) => !after.has(p)).length + [...after].filter((p) => !before.has(p)).length;
    if (moved > 0) reasons.push(`${moved} route-bearing file(s) added or removed`);
  }
  let changed = 0;
  let missing = 0;
  for (const e of target.examined) {
    const now = args.hashOf(e.path);
    if (now === null) missing++;
    else if (now !== e.hash) changed++;
  }
  if (changed > 0) reasons.push(`${changed} examined file(s) changed`);
  if (missing > 0) reasons.push(`${missing} examined file(s) gone`);

  const current = mapSignature({
    skill: args.skill,
    configSlice: args.configSlice,
    candidatePaths,
    examined: target.examined.map((e) => ({ path: e.path, hash: args.hashOf(e.path) ?? "gone" })),
  });
  const fresh = current === target.signature;
  if (!fresh && reasons.length === 0) reasons.push("the map's signature no longer matches");
  return { fresh, reasons: fresh ? [] : reasons };
}
