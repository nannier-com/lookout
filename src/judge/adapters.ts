/**
 * Which AIs lookout can judge with, and how to reach one by name.
 *
 * A registry rather than a list of strings, because "can judge" was never
 * really a property of a name: it is the presence of an adapter. The old
 * `JUDGES` constant said `["claude-code"]` and a comment beside it explained
 * that a tool with no adapter in this directory is a fixer and not a judge.
 * That comment was the registry, written in prose. This file is the same rule
 * written so the compiler keeps it: `JUDGES` is now derived, so a key can only
 * appear there by an adapter existing, and adding a third AI is one module and
 * one line here rather than a hunt for every place that assumed one.
 *
 * Handing an issue to a coding tool and asking one to rule on evidence remain
 * different powers, and `src/report/handoff.ts` still owns the first. A tool
 * can be a fixer without being a judge; being a judge is this file.
 */
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { AiAdapter, JudgeInvocation, JudgeReply } from "./ai-types.js";
import { LookoutError } from "../types.js";

/** Every AI with an adapter, in the order a page should offer them. */
export const ADAPTERS: readonly AiAdapter[] = [claudeAdapter, codexAdapter];

/**
 * The AIs lookout can judge with, by the key the page knows each tool as.
 *
 * Derived from the registry so the two can never disagree. Order is the
 * registry's order, which is the order the settings panel paints its rows in.
 */
export const JUDGES: readonly string[] = ADAPTERS.map((a) => a.key);

/** One AI by key, or the reason there is no such judge. */
export function adapterFor(key: string): AiAdapter {
  const found = ADAPTERS.find((a) => a.key === key);
  if (!found) {
    throw new LookoutError(
      `no AI adapter for "${key}"`,
      `lookout can judge with: ${JUDGES.join(", ")}`,
    );
  }
  return found;
}

/** Whether a key names an AI that can judge, for validating what was stored. */
export function isJudge(key: string): boolean {
  return ADAPTERS.some((a) => a.key === key);
}

/** One round trip with a named AI. */
export function invokeAi(key: string, inv: JudgeInvocation): Promise<JudgeReply> {
  return adapterFor(key).invoke(inv);
}

/**
 * The AI a call uses when nobody named one.
 *
 * The registry's first entry. Judging is still one AI per call, so this is
 * what every prompt builder falls back to; when a call names its own AI, that
 * one answers instead.
 */
export const PRIMARY_AI = JUDGES[0]!;

/**
 * How to tell THIS AI to open a screenshot, for the skill's `{{howToOpen}}`.
 *
 * One function because five prompt builders ask, and five spellings of the
 * same question is how a page comes to promise one thing while the run does
 * another. An unknown key falls back to the primary rather than throwing: a
 * prompt is not the place to discover a bad configuration, and the invocation
 * that follows will refuse it properly.
 */
export function readingInstructionFor(key?: string): string {
  const found = ADAPTERS.find((a) => a.key === key);
  return (found ?? adapterFor(PRIMARY_AI)).readingInstruction;
}
