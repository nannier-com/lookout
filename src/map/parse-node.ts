/**
 * One node of the screen mapper's reply, held to the contract.
 *
 * The reply is model output headed for filenames, fingerprints, a URL bar and
 * a real click, so nothing in it is trusted. Every check here has a failure
 * mode that ends with somebody opening a file that does not contain what they
 * were told, or lookout clicking something the config said never to touch.
 * The worst of them is a citation: a path that does not exist or a symbol
 * that is not in the file is fabrication, and it is counted as such.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { validStateName } from "../navigate/store.js";
import { PLATFORMS, type PlatformKind } from "../types.js";
import type { MapNode, MapOpen, MapOutcome, MapRisk, MapSource } from "./store.js";

export interface ParseTarget {
  name: string;
  url: string;
  routes: { path: string; name: string; states: string[] }[];
}

export interface ParseContext {
  targets: ParseTarget[];
  /** Hand-written state recipe names, which always win a collision. */
  recipeNames: ReadonlySet<string>;
  /** The platforms this project can walk; a node names a subset or inherits. */
  fold: PlatformKind[];
  projectDir: string;
  repoRoot: string;
  limits: { maxScreens: number; maxDepth: number; maxChildren: number };
  /** Accessible-name substrings and paths the config said never to map. */
  exclude: string[];
  /** A file's text, or null when it cannot be read. Injected so the tests need no disk. */
  readText: (absPath: string) => string | null;
}

export function readTextFromDisk(absPath: string): string | null {
  try {
    return existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
  } catch {
    return null;
  }
}

export type NodeCheck =
  | { ok: true; node: MapNode }
  | { ok: false; reason: string; fabricated?: boolean };

const RISKS: readonly MapRisk[] = ["safe", "destructive", "session-destructive"];
const RISK_RANK: Record<MapRisk, number> = { safe: 0, destructive: 1, "session-destructive": 2 };
const STATE_OUTCOMES: readonly MapOutcome[] = ["overlay", "in-page-change"];
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function riskRank(risk: MapRisk): number {
  return RISK_RANK[risk];
}

/** The path a route node names, or why it cannot be one. */
export function normalizeRoute(raw: unknown, targetUrl: string): { path: string } | { reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { reason: "no path" };
  let path = raw.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.origin !== new URL(targetUrl).origin) return { reason: `off-origin (${url.origin})` };
      path = url.pathname;
    } catch {
      return { reason: "not a URL" };
    }
  }
  path = path.replace(/[?#].*$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (/[:*[\]{}()\s]/.test(path)) return { reason: `parametrised path ${JSON.stringify(path)}` };
  return { path };
}

function excluded(text: string | undefined, exclude: readonly string[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const e of exclude) {
    const needle = e.toLowerCase();
    if (needle.startsWith("/") ? lower === needle || lower.startsWith(`${needle}/`) : lower.includes(needle)) return e;
  }
  return null;
}

function checkOpen(raw: unknown, kind: MapNode["kind"], targetUrl: string): { open: MapOpen | null } | { reason: string } {
  if (raw === null || raw === undefined) {
    return kind === "route" ? { open: null } : { reason: "a state needs an `open` action" };
  }
  if (typeof raw !== "object") return { reason: "open is not an object" };
  const o = raw as Record<string, unknown>;
  const outcome = kind === "route" ? (o.outcome ?? "navigation") : o.outcome;
  if (kind === "route" && outcome !== "navigation") return { reason: `a route opens by navigation, not ${JSON.stringify(outcome)}` };
  if (kind === "state" && !STATE_OUTCOMES.includes(outcome as MapOutcome)) {
    return { reason: `unknown outcome ${JSON.stringify(outcome)}` };
  }
  const open: MapOpen = { outcome: outcome as MapOutcome };
  if (o.affordance !== undefined) {
    const a = o.affordance as Record<string, unknown>;
    if (typeof a !== "object" || a === null || typeof a.role !== "string" || typeof a.name !== "string" || !a.name.trim()) {
      return { reason: "affordance needs a role and a name" };
    }
    const affordance: NonNullable<MapOpen["affordance"]> = { role: a.role.trim(), name: a.name.trim().slice(0, 80) };
    if (typeof a.selector === "string" && a.selector.trim()) affordance.selector = a.selector.trim();
    if (typeof a.href === "string" && a.href.trim()) {
      const href = a.href.trim();
      if (/^https?:\/\//i.test(href)) {
        try {
          if (new URL(href).origin !== new URL(targetUrl).origin) return { reason: `off-origin link ${href}` };
        } catch {
          return { reason: `bad href ${href}` };
        }
      }
      affordance.href = href;
    }
    open.affordance = affordance;
  }
  if (o.deepLink !== undefined) {
    if (typeof o.deepLink !== "string" || !o.deepLink.startsWith("/")) return { reason: "deepLink must be a path" };
    open.deepLink = o.deepLink;
  }
  if (o.tap !== undefined) {
    const t = o.tap as Record<string, unknown>;
    if (typeof t !== "object" || t === null || typeof t.label !== "string" || !t.label.trim()) {
      return { reason: "tap needs a label" };
    }
    open.tap = { label: t.label.trim().slice(0, 80) };
  }
  if (kind === "state" && !open.affordance && !open.tap) return { reason: "a state needs an affordance or a tap" };
  return { open };
}

/** The citation, verified against the file: the file's own line wins over the reply's. */
function checkSource(raw: unknown, ctx: ParseContext): { source: MapSource } | { reason: string; fabricated: boolean } {
  if (typeof raw !== "object" || raw === null) return { reason: "no source cited", fabricated: true };
  const s = raw as Record<string, unknown>;
  if (typeof s.path !== "string" || !s.path.trim()) return { reason: "no source path", fabricated: true };
  const abs = isAbsolute(s.path) ? resolve(s.path) : resolve(ctx.projectDir, s.path);
  const rel = relative(ctx.repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).includes("node_modules")) {
    return { reason: `source ${s.path} is outside the repository`, fabricated: true };
  }
  const text = ctx.readText(abs);
  if (text === null) return { reason: `source ${s.path} does not exist`, fabricated: true };
  const source: MapSource = { path: abs };
  const symbol = typeof s.symbol === "string" ? s.symbol.trim() : "";
  if (symbol) {
    if (!IDENTIFIER.test(symbol)) return { reason: `"${symbol}" is not an identifier`, fabricated: false };
    const decl = new RegExp(`(?:function|const|let|var|class)\\s+${symbol}\\b`).exec(text);
    const mention = decl ?? new RegExp(`\\b${symbol}\\b`).exec(text);
    if (!mention) return { reason: `symbol ${symbol} is not in ${rel}`, fabricated: true };
    source.symbol = symbol;
    source.line = text.slice(0, mention.index).split("\n").length;
  } else if (typeof s.line === "number" && Number.isInteger(s.line)) {
    const lines = text.split("\n").length;
    if (s.line >= 1 && s.line <= lines) source.line = s.line;
  }
  return { source };
}

/**
 * One node, checked on its own: shape, id, open, risk, platforms, citation.
 * Tree-level rules (duplicates, cycles, caps, roots) live in parse.ts.
 */
export function checkNode(
  raw: unknown,
  ctx: ParseContext,
  target: ParseTarget,
  parent: { risk: MapRisk; platforms: PlatformKind[] } | null,
): NodeCheck {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== "route" && kind !== "state") return { ok: false, reason: `unknown kind ${JSON.stringify(kind)}` };
  let id: string;
  let path: string | undefined;
  if (kind === "route") {
    const route = normalizeRoute(r.path ?? r.id, target.url);
    if ("reason" in route) return { ok: false, reason: route.reason };
    path = route.path;
    id = path;
  } else {
    if (typeof r.id !== "string" || !validStateName(r.id)) {
      return { ok: false, reason: `state id ${JSON.stringify(r.id)} is not a valid state name` };
    }
    if (ctx.recipeNames.has(r.id)) return { ok: false, reason: `state id "${r.id}" is a hand-written recipe's` };
    id = r.id;
  }
  const opened = checkOpen(r.open, kind, target.url);
  if ("reason" in opened) return { ok: false, reason: `${id}: ${opened.reason}` };

  const hit = excluded(path, ctx.exclude) ?? excluded(opened.open?.affordance?.name, ctx.exclude) ?? excluded(opened.open?.tap?.label, ctx.exclude);
  if (hit) return { ok: false, reason: `${id}: excluded by config (${JSON.stringify(hit)})` };

  const own = RISKS.includes(r.risk as MapRisk) ? (r.risk as MapRisk) : "safe";
  const risk = parent && riskRank(parent.risk) > riskRank(own) ? parent.risk : own;

  const named = Array.isArray(r.platforms)
    ? r.platforms.filter((p): p is PlatformKind => (PLATFORMS as readonly unknown[]).includes(p) && ctx.fold.includes(p as PlatformKind))
    : [];
  const platforms = named.length > 0 ? [...new Set(named)] : parent ? parent.platforms : ctx.fold;
  if (platforms.length === 0) return { ok: false, reason: `${id}: no platform this project walks` };

  const cited = checkSource(r.source, ctx);
  if ("reason" in cited) return { ok: false, reason: `${id}: ${cited.reason}`, fabricated: cited.fabricated };

  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 80) : id;
  const why = typeof r.why === "string" ? r.why.trim().slice(0, 200) : "";
  return {
    ok: true,
    node: { id, kind, ...(path ? { path } : {}), title, open: opened.open, risk, platforms, source: cited.source, why, children: [] },
  };
}
