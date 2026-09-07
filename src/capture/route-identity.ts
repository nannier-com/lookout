import { createHash } from "node:crypto";
import { join } from "node:path";

import type { FormFactor, PlatformKind, Scheme } from "../types.js";

export interface RouteAxes {
  target: string;
  route: string;
  state: string;
  platform: PlatformKind;
  formFactor: FormFactor;
  scheme: Scheme;
}

/** The exact route spelling used everywhere after config resolution. */
export function normalizeRoute(route: string): string {
  return route.startsWith("/") ? route : `/${route}`;
}

export function duplicateNormalizedRoute(
  routes: readonly (string | { path: string })[],
): { index: number; prior: number; route: string } | null {
  const seen = new Map<string, number>();
  for (const [index, value] of routes.entries()) {
    const route = normalizeRoute(typeof value === "string" ? value : value.path);
    const prior = seen.get(route);
    if (prior !== undefined) return { index, prior, route };
    seen.set(route, index);
  }
  return null;
}

/** The lossy token written by Lookout releases before canonical route ids. */
export function legacyRouteSlug(route: string): string {
  const s = normalizeRoute(route)
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
  return s || "root";
}

/**
 * A bounded, filesystem-safe token derived from every route Lookout accepts.
 * Existing lowercase one-segment routes keep their old token. Root
 * also keeps `root`; `/root` enters the reserved digest namespace so the two
 * can never share pixels again.
 */
export function routeToken(route: string): string {
  const normalized = normalizeRoute(route);
  if (normalized === "/") return "root";
  if (
    /^\/[a-z0-9-]+$/.test(normalized) &&
    normalized !== "/root" &&
    Buffer.byteLength(normalized.slice(1), "utf8") <= 120
  ) {
    return normalized.slice(1);
  }
  return `_route-${createHash("sha256").update(normalized).digest("hex")}`;
}

export function canonicalShotId(a: RouteAxes): string {
  return [a.platform, a.target, routeToken(a.route), a.state, a.formFactor, a.scheme].join("/");
}

export function legacyShotId(a: RouteAxes): string {
  return [a.platform, a.target, legacyRouteSlug(a.route), a.state, a.formFactor, a.scheme].join("/");
}

export function canonicalShotRelPath(a: RouteAxes): string {
  return join(a.platform, a.target, routeToken(a.route), `${a.state}--${a.formFactor}-${a.scheme}.png`);
}

export function legacyShotRelPath(a: RouteAxes): string {
  return join(a.platform, a.target, legacyRouteSlug(a.route), `${a.state}--${a.formFactor}-${a.scheme}.png`);
}
