/**
 * The dedupe identity of a finding, across runs and across machines.
 *
 * Axes only, never prose: a fingerprint made from a title would change every
 * time the judge reworded itself, and the same defect would arrive as a new one
 * on every check. What it is made of is what a defect IS, which is why this is
 * the one thing in the backlog that must never quietly change shape.
 */
import { routeSlug } from "../capture/store.js";
import type { FormFactor, Scheme } from "../types.js";
import type { SourceRef } from "./lib.js";

// Fingerprints: the dedupe identity across runs. Axes only, no prose, so a
// re-found defect merges instead of duplicating.

export function fingerprintOf(f: {
  target: string;
  route: string;
  state: string;
  formFactor?: FormFactor;
  scheme?: Scheme;
  category: string;
  attribute: string;
}): string {
  return [
    f.target,
    routeSlug(f.route),
    f.state,
    f.formFactor ?? "-",
    f.scheme ?? "-",
    f.category,
    f.attribute,
  ].join(".");
}

/**
 * The identity of a source finding: the file it is in and what is wrong there.
 *
 * Deliberately NOT the line number. A hand-rolled component that moves down the
 * file when an import is added is the same defect, and keying on the line would
 * file a new one on every unrelated edit above it.
 */
export function sourceFingerprintOf(f: {
  target: string;
  source: Pick<SourceRef, "relPath" | "symbol">;
  category: string;
  attribute: string;
}): string {
  return [
    f.target,
    "source",
    f.source.relPath,
    f.source.symbol ?? "-",
    f.category,
    f.attribute,
  ].join(".");
}
