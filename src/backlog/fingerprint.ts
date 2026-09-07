/**
 * The dedupe identity of a finding, across runs and across machines.
 *
 * Axes only, never prose: a fingerprint made from a title would change every
 * time the judge reworded itself, and the same defect would arrive as a new one
 * on every check. What it is made of is what a defect IS, which is why this is
 * the one thing in the backlog that must never quietly change shape.
 *
 * The route slot answers "where does this defect live", and the route is the
 * only axis a region may ever replace, because it is the only axis asking the
 * same question. For a defect in the application's persistent chrome the
 * answer is a component, not a screen: the screen it was photographed on is an
 * accident of which route the capture visited first, and keying on it filed
 * one clipped header control as a separate defect per route. A shell region
 * takes the route's slot, spelled `@<region>` because a route token can never
 * emit an `@`, so the two vocabularies
 * cannot collide. Form factor and scheme stay in the key either way: a desktop
 * nav rail and a phone tab bar are different components, and fusing them would
 * let a fix photographed on one close evidence about the other.
 *
 * A device finding carries its platform too. An iOS screen and the web page it
 * mirrors are two renderings from two codebases, so a defect on one is not
 * evidence about the other; a web fingerprint is byte-identical to what it
 * always was, because every existing backlog is keyed by it.
 */
import { legacyRouteSlug, routeToken } from "../capture/route-identity.js";
import { isShellRegion, type Region } from "./region.js";
import type { FormFactor, PlatformKind, Scheme } from "../types.js";
import type { SourceRef } from "./lib.js";

// Fingerprints: the dedupe identity across runs. Axes only, no prose, so a
// re-found defect merges instead of duplicating.

export function fingerprintOf(f: {
  target: string;
  route: string;
  state: string;
  platform?: PlatformKind;
  formFactor?: FormFactor;
  scheme?: Scheme;
  category: string;
  attribute: string;
  region?: Region;
}): string {
  const where = isShellRegion(f.region) ? `@${f.region}` : routeToken(f.route);
  return [
    f.target,
    where,
    f.state,
    ...(f.platform && f.platform !== "web" ? [f.platform] : []),
    f.formFactor ?? "-",
    f.scheme ?? "-",
    f.category,
    f.attribute,
  ].join(".");
}

/** The route-derived fingerprint emitted before canonical route tokens. */
export function legacyFingerprintOf(f: Parameters<typeof fingerprintOf>[0]): string {
  const where = isShellRegion(f.region) ? `@${f.region}` : legacyRouteSlug(f.route);
  return [
    f.target,
    where,
    f.state,
    ...(f.platform && f.platform !== "web" ? [f.platform] : []),
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
