/**
 * What a navigation tool is, and the state every tool works on: the session,
 * the driver, the actions so far, the last snapshot's references, and what
 * `arrive` produced. The registry (tools.ts) assembles the tools; the
 * server (server.ts) exposes them; this file is the shape they share.
 */
import type { z } from "zod";
import type { EventLog } from "../report/events.js";
import type { PlatformKind } from "../types.js";
import type { AffordanceRef } from "../navigate/store.js";
import type { NavAction } from "./actions.js";
import { ToolRefusal, type Arrived, type Driver, type Snapshot } from "./driver.js";
import type { NavCall, NavSession } from "./session.js";

export interface ToolState {
  session: NavSession;
  driver: Driver;
  /** Every mutating action since `open`, resolved, in order. */
  actions: NavAction[];
  snapshot: Snapshot | null;
  calls: NavCall[];
  arrived: Arrived | null;
  log: EventLog;
}

export interface ToolReply {
  text: string;
  /** A JPEG for the model to look at. */
  image?: Buffer;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  platforms: readonly PlatformKind[];
  input: Shape;
  /** Counts against the action budget, and is refused once the screen is captured. */
  mutating: boolean;
  run: (args: z.infer<z.ZodObject<Shape>>, state: ToolState) => Promise<ToolReply>;
}

/** Declare a tool with its input shape inferred, so `run` is typed by its own schema. */
export function tool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

/**
 * The control a tool call names: a reference from the last snapshot, or a
 * role and name spelled out. A reference is per snapshot; it is resolved to
 * the control it pointed at, and the control, never the reference, is what
 * the action records.
 */
export function affordanceOf(
  args: { ref?: string; role?: string; name?: string; selector?: string },
  state: ToolState,
): AffordanceRef {
  if (args.ref) {
    const hit = state.snapshot?.refs.get(args.ref);
    if (!hit) throw new ToolRefusal(`no ${JSON.stringify(args.ref)} in the last snapshot; call snapshot first`);
    if (hit.kind !== "web") throw new ToolRefusal(`${args.ref} is a device node, not a web control`);
    const a = hit.affordance;
    return { selector: a.selector, role: a.role, name: a.name, href: a.href };
  }
  if (args.role && args.name) return { selector: args.selector ?? "", role: args.role, name: args.name, href: null };
  throw new ToolRefusal("name the control: a ref from the last snapshot, or a role and a name");
}

/** The control's short name for a narration line. */
export function subjectOf(ref: AffordanceRef): string {
  return `${ref.role} ${JSON.stringify(ref.name)}`;
}

/** Refuse a mutating call once the budget is spent or the screen is already captured. */
export function requireBudget(state: ToolState): void {
  if (state.arrived) throw new ToolRefusal("the screen has been captured; reply now");
  if (state.actions.filter((a) => a.tool !== "open").length >= state.session.limits.maxActions) {
    throw new ToolRefusal(`budget spent (${state.session.limits.maxActions} actions): call arrive if the screen is showing, or reply that it is not`);
  }
}

/**
 * Every mutating tool's shape: check the budget, narrate, act through the
 * driver, record what happened, and answer with the screen the model now
 * stands on, so it needs no second call to see it.
 */
export async function actAndSnapshot(state: ToolState, action: NavAction, subject: string): Promise<string> {
  requireBudget(state);
  state.log.emit("phase", `navigator: ${action.tool} ${subject}`.trim(), { tool: action.tool, screen: state.session.screen.id });
  const outcome = await state.driver.act(action);
  action.outcome = outcome;
  state.actions.push(action);
  const snap = await state.driver.snapshot();
  state.snapshot = snap;
  return `${action.tool} ${subject}: ${outcome.navigated ? `navigated to ${outcome.url}` : "done"}\n\n${snap.text}`;
}
