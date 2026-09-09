/**
 * What the screen navigator is told: which screen, how the map says it is
 * reached, where it sits, what worked last time, and how this AI calls the
 * tools. Everything the model is told to think lives in the skill file; this
 * fills its slots.
 */
import { navigateInstructionFor } from "../judge/adapters.js";
import { loadSkill, renderSkill } from "../skills/load.js";
import type { PlatformKind, ResolvedConfig } from "../types.js";
import type { MapNode } from "../map/store.js";
import type { NavAction } from "./actions.js";

export interface NavigatePromptInput {
  target: string;
  platform: PlatformKind;
  screenId: string;
  node: MapNode;
  /** From the nearest route above the screen down to its parent, exclusive of the screen. */
  chain: readonly MapNode[];
  recorded?: readonly NavAction[];
  maxActions: number;
  /** The AI that will read this, for the tool vocabulary; the primary when absent. */
  ai?: string;
}

/** How the map says a node is reached, in a sentence. */
export function howToReachOf(node: MapNode): string {
  const o = node.open;
  const why = node.why ? ` The map's note: ${node.why}` : "";
  if (!o) return `by opening the route directly; nothing needs to be clicked.${why}`;
  if (o.affordance) {
    const a = o.affordance;
    const verb = o.outcome === "navigation" ? "follow" : "activate";
    const expects = o.outcome === "overlay" ? "something opens above the page" : o.outcome === "in-page-change" ? "the page changes in place" : "the app navigates";
    return `${verb} the ${a.role} ${JSON.stringify(a.name)}${a.href ? ` (${a.href})` : ""}${a.selector ? `, selector ${a.selector}` : ""}; the map expects that ${expects}.${why}`;
  }
  if (o.deepLink) return `by deep link to ${o.deepLink}.${why}`;
  if (o.tap) return `tap ${JSON.stringify(o.tap.label)}; the map expects that ${o.outcome === "overlay" ? "something opens above the screen" : "the screen changes"}.${why}`;
  return `${o.outcome}.${why}`;
}

/** A recorded action as one line a person could follow. */
export function actionLine(a: NavAction): string {
  const g = a.args;
  switch (a.tool) {
    case "open":
      return `open ${g.path ?? "/"}`;
    case "click":
    case "hover":
    case "type":
    case "scroll":
      return `${a.tool} the ${g.affordance?.role ?? "control"} ${JSON.stringify(g.affordance?.name ?? "")}${g.text !== undefined ? ` with ${JSON.stringify(g.text)}` : ""}${g.direction ? ` ${g.direction}` : ""}`;
    case "tap":
      return `tap ${g.label ? JSON.stringify(g.label) : `(${g.x}, ${g.y})`}`;
    case "press":
    case "key":
      return `${a.tool} ${g.key ?? ""}`;
    case "swipe":
      return `swipe from (${g.from?.x}, ${g.from?.y}) to (${g.to?.x}, ${g.to?.y})`;
    case "wait":
      return `wait ${g.ms ?? 0}ms`;
    default:
      return a.tool;
  }
}

function recordedBlock(recorded: readonly NavAction[] | undefined): string {
  const steps = (recorded ?? []).filter((a) => a.tool !== "open");
  if (steps.length === 0) return "Nobody has reached this screen before; the map's description is all there is.";
  return ["Last time, these steps reached it, and they may still work:", ...steps.map((a, i) => `${i + 1}. ${actionLine(a)}`)].join("\n");
}

export async function navigatePrompt(resolved: ResolvedConfig, input: NavigatePromptInput): Promise<{ prompt: string; skillVersion: number }> {
  const skill = await loadSkill(resolved, "navigate-screen");
  const chain = input.chain.map((n) => n.title).join(" > ");
  const prompt = renderSkill(skill.text, {
    project: resolved.project,
    target: input.target,
    platform: input.platform,
    screenId: input.screenId,
    screenName: input.node.title,
    howToReach: howToReachOf(input.node),
    parentChain: chain ? `${chain} > this screen` : "a top-level screen of the target",
    recorded: recordedBlock(input.recorded),
    howToCall: navigateInstructionFor(input.ai),
    maxActions: input.maxActions,
  });
  return { prompt, skillVersion: skill.version };
}
