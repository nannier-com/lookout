/**
 * Reaching one screen of the map, for the walk: by replaying what reached it
 * before (no AI), or by asking a navigator to reach it with lookout's tool
 * server. Either way the screen's shots land in the capture report under the
 * walk's run id before this returns, and neither way throws for a screen
 * that could not be reached: that is an answer the walk records.
 *
 * The file wins over the reply. A navigator that says it arrived is believed
 * only when the tool server wrote a capture; a navigator that says it did
 * not is believed on its word.
 */
import { EventLog } from "../report/events.js";
import { mergeRun } from "../capture/store.js";
import { extractJson } from "../judge/engine.js";
import { invokeAi } from "../judge/adapters.js";
import { NavSkip, NavStateError } from "../navigate/execute.js";
import { checkArrival } from "../mcp/replay-web.js";
import { DEFAULT_LIMITS, readNavSession, writeNavSession, type NavSession, type NavSessionInput } from "../mcp/session.js";
import { DeviceDriver } from "../mcp/driver-device.js";
import { WebDriver } from "../mcp/driver-web.js";
import { navigatePrompt } from "../mcp/prompt.js";
import type { Driver } from "../mcp/driver.js";
import type { Arrival, NavAction } from "../mcp/actions.js";
import type { MapNode } from "../map/store.js";
import { LookoutError, type PlatformKind, type ResolvedConfig, type RunRecord, type ShotRecord } from "../types.js";
import { nowIso } from "../util.js";

/** One screen of the map as the walk hands it over. */
export interface Screen {
  /** `target|route|state`. */
  id: string;
  target: string;
  route: string;
  routeName: string;
  state: string;
  node: MapNode;
  /** The state nodes between the nearest route above and this one, exclusive; each must carry a recording. */
  chain: readonly MapNode[];
  platforms: PlatformKind[];
  allowDestructive: boolean;
}

export interface ReachContext {
  resolved: ResolvedConfig;
  runId: string;
  platforms: PlatformKind[];
  formFactors: NavSession["matrix"]["formFactors"];
  schemes: NavSession["matrix"]["schemes"];
  capture: NavSession["capture"];
  navigator: { ai: string; model: string; timeoutMs: number };
  log: EventLog;
}

export type ReachResult =
  | { ok: true; how: "replay" | "navigator"; shots: ShotRecord[]; recorded: NavAction[]; arrival?: Arrival; costUsd: number; navigatorCalls: number; seconds: number; note?: string }
  | { ok: false; reason: string; lastLook?: string; costUsd: number; navigatorCalls: number; seconds: number };

/** The ancestors' recorded actions, opens dropped, or null when an ancestor was never reached. */
export function preludeOf(chain: readonly MapNode[]): NavAction[] | null {
  const out: NavAction[] = [];
  for (const node of chain) {
    if (!node.walk?.reached || !node.walk.actions) return null;
    out.push(...node.walk.actions.filter((a) => a.tool !== "open"));
  }
  return out;
}

function sessionFor(screen: Screen, ctx: ReachContext, platform: PlatformKind, prelude: NavAction[], recorded?: NavAction[]): NavSessionInput {
  const { config } = ctx.resolved;
  return {
    configPath: ctx.resolved.configPath!,
    runId: ctx.runId,
    target: screen.target,
    platform,
    screen: {
      id: screen.id,
      route: screen.route,
      routeName: screen.routeName,
      state: screen.state,
      ...(screen.node.title && screen.state !== "rest" ? { description: screen.node.title } : {}),
      ...(screen.node.open?.affordance
        ? {
            affordance: {
              selector: screen.node.open.affordance.selector ?? "",
              role: screen.node.open.affordance.role,
              name: screen.node.open.affordance.name,
              href: screen.node.open.affordance.href ?? null,
              outcome: screen.node.open.outcome,
            },
          }
        : {}),
    },
    prelude,
    ...(recorded ? { recorded } : {}),
    matrix: { formFactors: ctx.formFactors, schemes: ctx.schemes },
    capture: ctx.capture,
    exclude: [...(config.navigation?.exclude ?? []), ...(config.map?.exclude ?? [])],
    include: config.navigation?.include ?? [],
    allowDestructive: screen.allowDestructive,
    limits: { ...DEFAULT_LIMITS, invocationMs: ctx.navigator.timeoutMs },
  };
}

function driverFor(session: NavSession, ctx: ReachContext): Driver {
  const target = ctx.resolved.config.targets.find((t) => t.name === session.target);
  if (!target) throw new LookoutError(`unknown target "${session.target}"`);
  const dctx = { session, resolved: ctx.resolved, target, log: ctx.log };
  return session.platform === "web" ? new WebDriver(dctx) : new DeviceDriver(dctx);
}

async function merge(ctx: ReachContext, shots: ShotRecord[], failures: RunRecord["failures"], startedAt: string): Promise<void> {
  if (shots.length === 0 && failures.length === 0) return;
  const run: RunRecord = {
    id: ctx.runId,
    kind: shots.some((s) => s.platform === "web") || shots.length === 0 ? "web" : "native",
    startedAt,
    finishedAt: nowIso(),
    flags: { formFactors: ctx.formFactors, schemes: ctx.schemes, walk: true },
    failures,
    skips: [],
  };
  await mergeRun(ctx.resolved, run, shots);
}

function platformsOf(screen: Screen, ctx: ReachContext): PlatformKind[] {
  return ctx.platforms.filter((p) => screen.platforms.includes(p));
}

/** Reach the screen by doing again what reached it before. No AI. */
export async function replayScreen(screen: Screen, ctx: ReachContext): Promise<ReachResult> {
  const started = Date.now();
  const startedAt = nowIso();
  const prelude = preludeOf(screen.chain);
  if (!prelude) return { ok: false, reason: "a screen above this one has no recording yet", costUsd: 0, navigatorCalls: 0, seconds: 0 };
  const recorded = screen.state === "rest" ? [] : (screen.node.walk?.actions ?? []).filter((a) => a.tool !== "open");
  if (screen.state !== "rest" && !screen.node.walk?.reached) {
    return { ok: false, reason: "no recording for this screen", costUsd: 0, navigatorCalls: 0, seconds: 0 };
  }
  const shots: ShotRecord[] = [];
  const failures: RunRecord["failures"] = [];
  for (const platform of platformsOf(screen, ctx)) {
    const session: NavSession = { version: 1, ...sessionFor(screen, ctx, platform, prelude, recorded) };
    const driver = driverFor(session, ctx);
    try {
      ctx.log.emit("phase", `replaying ${screen.id} on ${platform}`, { screen: screen.id, platform });
      const opened: NavAction = { tool: "open", args: { path: screen.route }, outcome: {}, at: nowIso() };
      opened.outcome = await driver.open(screen.route);
      await driver.replay(recorded);
      // The screen the replay landed on, held to the one that was recorded,
      // on every platform: a device replay that ended on the home screen was
      // measured photographing it under the recorded screen's name while the
      // check only ran on the web.
      const snap = await driver.snapshot();
      if (screen.node.walk?.arrival && !checkArrivalOf(snap.arrival, screen.node.walk.arrival)) {
        throw new NavStateError("the replay did not land on the screen that was recorded");
      }
      const arrived = await driver.arrive([opened, ...recorded]);
      shots.push(...arrived.shots);
      failures.push(...arrived.failures.map((f) => ({ target: screen.target, route: screen.route, step: f.step, message: f.message })));
    } catch (e) {
      const why = e instanceof NavSkip || e instanceof NavStateError ? e.message : `replay failed: ${(e as Error).message.slice(0, 300)}`;
      await driver.close().catch(() => {});
      await merge(ctx, shots, failures, startedAt);
      return { ok: false, reason: why, costUsd: 0, navigatorCalls: 0, seconds: secondsSince(started) };
    }
    await driver.close().catch(() => {});
  }
  await merge(ctx, shots, failures, startedAt);
  if (shots.length === 0) return { ok: false, reason: failures[0]?.message ?? "the replay photographed nothing", costUsd: 0, navigatorCalls: 0, seconds: secondsSince(started) };
  return { ok: true, how: "replay", shots, recorded: screen.node.walk?.actions ?? [], costUsd: 0, navigatorCalls: 0, seconds: secondsSince(started) };
}

function checkArrivalOf(now: Arrival, then: Arrival): boolean {
  if (then.signature && now.signature === then.signature) return true;
  return checkArrival(
    now.sampleNames.length > 0 ? { signature: now.signature ?? "", harvestedAt: "", affordances: now.sampleNames.map((name, i) => ({ id: `a${i}`, tag: "", role: "", name, selector: "", href: null, inForm: false, submit: false, box: { x: 0, y: 0, w: 0, h: 0 } })) } : null,
    then,
  );
}

/** Reach the screen with a navigator: one AI call per platform, the tool server attached. */
export async function reachScreen(screen: Screen, ctx: ReachContext): Promise<ReachResult> {
  const started = Date.now();
  const startedAt = nowIso();
  const prelude = preludeOf(screen.chain);
  if (!prelude) return { ok: false, reason: "a screen above this one has no recording yet", costUsd: 0, navigatorCalls: 0, seconds: 0 };
  const shots: ShotRecord[] = [];
  const failures: RunRecord["failures"] = [];
  let costUsd = 0;
  let calls = 0;
  let recorded: NavAction[] = [];
  let arrival: Arrival | undefined;
  const notes: string[] = [];
  let lastLook: string | undefined;
  for (const platform of platformsOf(screen, ctx)) {
    const input = sessionFor(screen, ctx, platform, prelude, screen.node.walk?.actions?.filter((a) => a.tool !== "open"));
    const sessionPath = await writeNavSession(ctx.resolved, input);
    const { prompt } = await navigatePrompt(ctx.resolved, {
      target: screen.target,
      platform,
      screenId: screen.id,
      node: screen.node,
      chain: screen.chain,
      recorded: input.recorded,
      maxActions: input.limits.maxActions,
      ai: ctx.navigator.ai,
    });
    ctx.log.emit("phase", `navigator reaching ${screen.id} on ${platform}`, { screen: screen.id, platform });
    calls++;
    let claimed = false;
    let said = "";
    try {
      const reply = await invokeAi(ctx.navigator.ai, {
        prompt,
        model: ctx.navigator.model,
        capabilities: ["navigate"],
        navigation: { sessionPath },
        timeoutMs: ctx.navigator.timeoutMs,
      });
      costUsd += reply.spend?.usd ?? 0;
      try {
        const parsed = extractJson(reply.text) as { arrived?: unknown; note?: unknown };
        claimed = parsed.arrived === true;
        said = typeof parsed.note === "string" ? parsed.note : "";
      } catch {
        said = reply.text.slice(0, 200);
      }
    } catch (e) {
      failures.push({ target: screen.target, route: screen.route, step: `${platform} navigator`, message: (e as Error).message.slice(0, 500) });
      continue;
    }
    const result = (await readNavSession(sessionPath).catch(() => null))?.result;
    if (result?.lastLook) lastLook = result.lastLook;
    if (result?.arrived && result.shots.length > 0) {
      shots.push(...result.shots);
      failures.push(...result.failures.map((f) => ({ target: screen.target, route: screen.route, step: f.step, message: f.message })));
      if (platform === "web" || recorded.length === 0) {
        recorded = result.actions;
        arrival = result.arrival;
      }
      if (said) notes.push(said);
    } else {
      const why = result?.arrived ? "the tool server captured nothing" : claimed ? "the navigator said it arrived, but the tool server recorded no capture" : said || "the navigator could not reach it";
      failures.push({ target: screen.target, route: screen.route, step: `${platform} navigator`, message: why });
    }
  }
  await merge(ctx, shots, failures, startedAt);
  if (shots.length === 0) {
    return { ok: false, reason: failures[0]?.message ?? "nothing was captured", ...(lastLook ? { lastLook } : {}), costUsd, navigatorCalls: calls, seconds: secondsSince(started) };
  }
  return { ok: true, how: "navigator", shots, recorded, ...(arrival ? { arrival } : {}), costUsd, navigatorCalls: calls, seconds: secondsSince(started), ...(notes.length ? { note: notes.join(" ") } : {}) };
}

function secondsSince(started: number): number {
  return Math.round((Date.now() - started) / 1000);
}
