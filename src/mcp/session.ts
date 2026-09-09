/**
 * The file a navigation session travels in: what the walk asks the tool
 * server to do, and what the server writes back.
 *
 * The server is a separate process the AI's CLI spawns, so everything it
 * needs to know arrives as one absolute path on its command line, and
 * everything it learned is left in the same file when it exits. The file, not
 * the model's reply, is the record: the reply says what the model believes
 * it did, the file says what the server saw happen.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { evidenceDir } from "../config.js";
import { atomicWriteJson } from "../state/atomic.js";
import type { FormFactor, PlatformKind, ResolvedConfig, Scheme, ShotRecord } from "../types.js";
import type { WebCaptureOptions } from "../capture/web.js";
import { nowIso, shortHash } from "../util.js";
import type { Arrival, NavAction } from "./actions.js";

export interface NavScreen {
  /** The global screen id: `target|route|state`. */
  id: string;
  /** The route the shots are filed under. */
  route: string;
  routeName: string;
  /** `rest`, or a state name that passes `validStateName`. */
  state: string;
  /** The element selector for the shot; null forces full page; absent uses the route's. */
  element?: string | null;
  description?: string;
  /** What was clicked to reach it, for the shot record. */
  affordance?: { selector: string; role: string; name: string; href: string | null; outcome: string };
}

export interface NavLimits {
  /** Mutating tool calls the navigator may make before every further one is refused. */
  maxActions: number;
  toolTimeoutMs: number;
  /** How long the whole navigator call may run; the server exits a minute after. */
  invocationMs: number;
}

export const DEFAULT_LIMITS: NavLimits = { maxActions: 40, toolTimeoutMs: 15_000, invocationMs: 8 * 60_000 };

export interface NavCall {
  method: string;
  tool?: string;
  at: string;
  ok: boolean;
  ms: number;
}

export interface NavResult {
  arrived: boolean;
  at: string;
  /** Every mutating action since `open`, resolved, in order: what replay runs. */
  actions: NavAction[];
  arrival?: Arrival;
  shots: ShotRecord[];
  failures: { step: string; message: string }[];
  calls: NavCall[];
  note?: string;
  /** The last picture the navigator asked for, evidence-relative: what a person sees of a screen it never reached. */
  lastLook?: string;
}

export interface NavSession {
  version: 1;
  /** Absolute; the server loads the config itself (a signIn hook is a function). */
  configPath: string;
  /** The run the server narrates into. */
  runId: string;
  target: string;
  platform: PlatformKind;
  screen: NavScreen;
  /** The ancestors' recorded actions, replayed by `open` before the model acts. */
  prelude: NavAction[];
  /** The last hop that worked before, offered to the model. */
  recorded?: NavAction[];
  matrix: { formFactors: FormFactor[]; schemes: Scheme[] };
  capture: Pick<WebCaptureOptions, "settleMs" | "axe" | "axeContrast" | "provenance" | "aria" | "edgeClip" | "headless">;
  exclude: string[];
  include: string[];
  allowDestructive: boolean;
  limits: NavLimits;
  result?: NavResult;
}

export type NavSessionInput = Omit<NavSession, "version" | "result">;

/** Where a screen's session file lives: under the capture workspace, named by the screen. */
export function navSessionPath(resolved: ResolvedConfig, screenId: string): string {
  const token = screenId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "screen";
  return join(evidenceDir(resolved), "navigate", `${token}-${shortHash(Buffer.from(screenId))}.json`);
}

export async function writeNavSession(resolved: ResolvedConfig, input: NavSessionInput): Promise<string> {
  const path = navSessionPath(resolved, input.screen.id);
  await mkdir(dirname(path), { recursive: true });
  const session: NavSession = { version: 1, ...input };
  await atomicWriteJson(path, session);
  return path;
}

export async function readNavSession(path: string): Promise<NavSession> {
  if (!existsSync(path)) throw new Error(`no navigation session at ${path}`);
  const parsed = JSON.parse(await readFile(path, "utf8")) as NavSession;
  if (parsed.version !== 1) throw new Error(`navigation session ${path} is version ${String(parsed.version)}, not 1`);
  return parsed;
}

/** The server's record, written whole so a half-written result never reads as one. */
export async function writeNavResult(path: string, result: NavResult): Promise<void> {
  const session = await readNavSession(path);
  await atomicWriteJson(path, { ...session, result });
}

/** A result for a session that never arrived: what a crashed or timed-out server leaves behind. */
export function emptyResult(calls: NavCall[], note: string): NavResult {
  return { arrived: false, at: nowIso(), actions: [], shots: [], failures: [], calls, note };
}
