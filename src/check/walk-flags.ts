/**
 * What a screen walk may spend and how it may reach a screen, from the flags.
 *
 * Every number flag is a string (the parser knows nothing about numbers), so a
 * bare `--max-screens` or a word where a number should be is refused rather
 * than silently taking the default: a cap somebody typed and lookout dropped
 * is how a run comes to cost what nobody agreed to.
 */
import { DEFAULT_JUDGE_MODEL, isJudge, JUDGES, PRIMARY_AI } from "../judge/engine.js";
import { LookoutError } from "../types.js";
import { list, num, str, type Parsed } from "../util.js";

/** Navigator calls one run may spend; replays are free and uncounted. */
export const DEFAULT_MAX_NAVIGATOR_CALLS = 20;

export interface WalkCaps {
  /** Stop at the first screen with standing findings: the ui play button's loop. */
  first: boolean;
  /** Screens to walk before the rest are reported as not walked; null = every one. */
  maxScreens: number | null;
  maxNavigatorCalls: number;
  /** Stop once reach plus judging spend exceeds this; null = no ceiling. */
  budgetUsd: number | null;
  navigator: { ai: string; model: string };
  /** Replay a recording first (the default), never (re-record every screen), or only (spend no navigator). */
  replay: "first" | "never" | "only";
  screens: string[] | undefined;
}

function number(parsed: Parsed, flag: string): number | null {
  const raw = parsed.flags[flag];
  if (raw === undefined) return null;
  const n = num(raw);
  if (n === undefined) throw new LookoutError(`--${flag} needs a number`);
  return n;
}

/** `[ai:]model`, the `--challenger` spelling; a bare model is the primary AI's. */
export function navigatorOf(flag: string | undefined, judgeModel: string | undefined): { ai: string; model: string } {
  if (!flag) return { ai: PRIMARY_AI, model: judgeModel ?? DEFAULT_JUDGE_MODEL };
  const at = flag.indexOf(":");
  if (at === -1) return { ai: PRIMARY_AI, model: flag };
  const ai = flag.slice(0, at);
  const model = flag.slice(at + 1).trim();
  if (!isJudge(ai)) throw new LookoutError(`no AI adapter for "${ai}"`, `lookout can navigate with: ${JUDGES.join(", ")}`);
  if (!model) throw new LookoutError(`--navigator-model ${ai} names no model`, `write it as --navigator-model ${ai}:<model>`);
  return { ai, model };
}

export function walkCaps(parsed: Parsed): WalkCaps {
  if (parsed.flags["no-replay"] && parsed.flags["replay-only"]) {
    throw new LookoutError("--no-replay and --replay-only contradict each other");
  }
  return {
    first: !!parsed.flags.first,
    maxScreens: number(parsed, "max-screens"),
    maxNavigatorCalls: number(parsed, "max-navigator-calls") ?? DEFAULT_MAX_NAVIGATOR_CALLS,
    budgetUsd: number(parsed, "budget-usd"),
    navigator: navigatorOf(str(parsed.flags["navigator-model"]), str(parsed.flags.model)),
    replay: parsed.flags["no-replay"] ? "never" : parsed.flags["replay-only"] ? "only" : "first",
    screens: list(parsed.flags.screens),
  };
}
