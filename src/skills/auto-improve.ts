/**
 * The automatic learning trigger: `check` and `verify-fix` end by asking
 * whether this project has accumulated enough NEW evidence to run `skills
 * improve`, and run it when it has.
 *
 * The argument is the one amend.ts already makes about the apply gate: "a
 * gate a human has to walk through every time is a gate that stops being
 * walked" now applies to the trigger itself, and what makes it safe is
 * unchanged, the gate is evidence rather than judgement. The countervailing
 * rule gets equal weight: auto-spend is visible (narrated, in the event log,
 * in history.jsonl), capped (one amendment plus one frozen-set replay, at
 * most once per cooldown), and declinable (--no-improve for the run,
 * learn.auto: false for the project, and CI never auto-learns, because an
 * ephemeral checkout would write amendments the next job throws away).
 *
 * An improve failure is never the verb's failure: the whole attempt is
 * try/caught into the incident log, and the caller's exit code is computed
 * before this ever runs.
 */
import { gatherSignals } from "./signals.js";
import { loadWatermark, newSignals } from "./watermark.js";
import { improveLockPath } from "./history.js";
import { recordIncident } from "./incidents.js";
import { improveSkills } from "./amend.js";
import { lockHeld, nowIso } from "../util.js";
import { emit } from "../report/events.js";
import type { Parsed } from "../util.js";
import type { ResolvedConfig } from "../types.js";

export const DEFAULT_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_HOURS = 24;

export interface AutoImproveResult {
  ran: boolean;
  /** Why it did not run, when it did not. One phrase, for the payload. */
  skipped?: string;
  /** The watermark's account of what the run did, when it ran. */
  action?: string | null;
  exit?: number;
}

/** The decision alone, pure enough to test: run, or say why not. */
export function shouldAutoImprove(args: {
  configured: boolean;
  declined: boolean;
  ci: boolean;
  improveLockHeld: boolean;
  healLockHeld: boolean;
  lastImproveAt: string | null;
  cooldownHours: number;
  now: string;
  newCount: number;
  newByDesign: number;
  threshold: number;
}): { run: boolean; skipped?: string } {
  if (!args.configured) return { run: false, skipped: "no config file" };
  if (args.declined) return { run: false, skipped: "declined (--no-improve or learn.auto: false)" };
  if (args.ci) return { run: false, skipped: "CI environment" };
  if (args.improveLockHeld) return { run: false, skipped: "another improve is running" };
  // A heal's replay gate runs `skills replay` inside a project directory; an
  // improve rewriting the skill layer mid-replay would grade the heal
  // against a moving target.
  if (args.healLockHeld) return { run: false, skipped: "a self-heal is running" };
  if (args.lastImproveAt) {
    const elapsed = Date.parse(args.now) - Date.parse(args.lastImproveAt);
    if (elapsed < args.cooldownHours * 3_600_000) {
      return { run: false, skipped: `cooldown (last improve ${args.lastImproveAt})` };
    }
  }
  // A by-design adjudication fires alone: a person wrote a rule down
  // precisely so lookout would learn it, and making it wait behind two more
  // misjudgements defeats the point.
  if (args.newByDesign > 0) return { run: true };
  if (args.newCount >= args.threshold) return { run: true };
  return { run: false, skipped: `${args.newCount} new signal(s), threshold ${args.threshold}` };
}

export async function maybeAutoImprove(
  resolved: ResolvedConfig,
  parsed: Parsed,
  log: (line: string) => void,
): Promise<AutoImproveResult> {
  const model = typeof parsed.flags.model === "string" ? parsed.flags.model : "sonnet";
  try {
    const learn = resolved.config.learn ?? {};
    const signals = await gatherSignals(resolved);
    const mark = await loadWatermark(resolved);
    const fresh = newSignals(mark, signals);
    // No checkout, no heal: an installed package cannot run one, so its lock
    // cannot be held and the improve is not waiting on anything.
    const { ownCheckout, selfHealLockPath } = await import("../checkout.js");
    const checkout = ownCheckout();
    const decision = shouldAutoImprove({
      configured: !!resolved.configPath,
      declined: !!parsed.flags["no-improve"] || learn.auto === false,
      ci: !!process.env.CI,
      improveLockHeld: lockHeld(improveLockPath(resolved)),
      healLockHeld: !!checkout && lockHeld(selfHealLockPath(checkout)),
      lastImproveAt: mark.lastImproveAt,
      cooldownHours: learn.cooldownHours ?? DEFAULT_COOLDOWN_HOURS,
      now: nowIso(),
      newCount: fresh.length,
      newByDesign: fresh.filter((s) => s.kind === "by-design").length,
      threshold: learn.threshold ?? DEFAULT_THRESHOLD,
    });
    if (!decision.run) return { ran: false, skipped: decision.skipped };

    log(`\n${fresh.length} new signal(s) since the last improve; learning from them now (--no-improve declines)`);
    emit("note", `auto-improve: ${fresh.length} new signal(s), running skills improve`, {
      signals: fresh.length,
    });
    const exit = await improveSkills(resolved, model, { auto: true });
    const after = await loadWatermark(resolved);
    return { ran: true, action: after.lastAction, exit };
  } catch (e) {
    // Never the verb's failure. Durable, though: a trigger that keeps dying
    // is exactly what the incident log exists to show.
    const message = e instanceof Error ? e.message : String(e);
    emit("error", `auto-improve failed: ${message}`, {}, "error");
    recordIncident({
      at: nowIso(),
      kind: "crash",
      verb: "skills-improve-auto",
      message: `auto-improve failed: ${message.slice(0, 300)}`,
      project: resolved.projectDir,
    });
    return { ran: false, skipped: "failed (recorded as an incident)" };
  }
}
