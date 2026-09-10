/**
 * The tools a navigator has on a web page. Every mutating tool resolves the
 * control it was asked about, performs the action through the same code
 * replay will use, records what happened, and answers with a fresh snapshot
 * so the model sees the screen it now stands on without a second call.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { nowIso } from "../util.js";
import type { NavAction } from "./actions.js";
import { ToolRefusal } from "./driver.js";
import { actAndSnapshot as act, affordanceOf, subjectOf, tool, type ToolDef } from "./tool.js";

const control = {
  ref: z.string().optional().describe("a control's id from the last snapshot (a1, a2, ...)"),
  role: z.string().optional().describe("the control's role, when naming it instead of a ref"),
  name: z.string().optional().describe("the control's accessible name, when naming it instead of a ref"),
  selector: z.string().optional().describe("a CSS selector, only when the ref and the name both fail"),
};

export const snapshot = tool({
  name: "snapshot",
  description: "What is on the screen now: on the web its url and title and every control a person could act on, on a device every tappable node, one per line with an id you can pass to click, tap, type, hover or scroll. Call this before acting.",
  platforms: ["web", "ios", "android"],
  input: {},
  mutating: false,
  run: async (_args, state) => {
    const snap = await state.driver.snapshot();
    state.snapshot = snap;
    return { text: snap.text };
  },
});

export const look = tool({
  name: "look",
  description: "A picture of the screen as it is right now, for your own eyes when the snapshot leaves you unsure. Not a capture: lookout takes the record when you call arrive.",
  platforms: ["web", "ios", "android"],
  input: {},
  mutating: false,
  run: async (_args, state) => {
    const { image, note } = await state.driver.look();
    // Kept on disk as well: when the navigator gives up, the last thing it
    // saw is what a person needs in order to see why.
    const name = `look-${state.calls.length}.jpg`;
    try {
      await mkdir(state.lookDir.abs, { recursive: true });
      await writeFile(join(state.lookDir.abs, name), image);
      state.lastLook = `${state.lookDir.rel}/${name}`;
    } catch {
      // A picture that could not be kept is still a picture the model can see.
    }
    return { text: `the screen as it is now: ${note}`, image };
  },
});

export const open = tool({
  name: "open",
  description: "Go to a route of the target by path (for example /settings), then replay the steps that reach the parent screen. Resets the actions recorded so far. Answers with the screen's snapshot.",
  platforms: ["web", "ios", "android"],
  input: { path: z.string().describe("the route path, with a leading slash") },
  mutating: true,
  run: async (args, state) => {
    if (state.arrived) throw new ToolRefusal("the screen has been captured; reply now");
    state.log.emit("phase", `navigator: open ${args.path}`, { tool: "open", screen: state.session.screen.id });
    const action: NavAction = { tool: "open", args: { path: args.path }, outcome: {}, at: nowIso() };
    action.outcome = await state.driver.open(args.path);
    state.actions = [action];
    const snap = await state.driver.snapshot();
    state.snapshot = snap;
    return { text: `opened ${action.outcome.url ?? args.path}\n\n${snap.text}` };
  },
});

export const click = tool({
  name: "click",
  description: "Click a control named by its snapshot id, or by role and name. Refused when it would leave the target, matches the config's exclusions, or submits a form on a screen not marked destructive. Answers with the new snapshot.",
  platforms: ["web"],
  input: control,
  mutating: true,
  run: async (args, state) => {
    const affordance = affordanceOf(args, state);
    return { text: await act(state, { tool: "click", args: { affordance }, outcome: {}, at: nowIso() }, subjectOf(affordance)) };
  },
});

export const type = tool({
  name: "type",
  description: "Replace the text of a field named by its snapshot id, or by role and name.",
  platforms: ["web"],
  input: { ...control, text: z.string().describe("what the field should contain afterwards") },
  mutating: true,
  run: async (args, state) => {
    const affordance = affordanceOf(args, state);
    return { text: await act(state, { tool: "type", args: { affordance, text: args.text }, outcome: {}, at: nowIso() }, subjectOf(affordance)) };
  },
});

export const press = tool({
  name: "press",
  description: "Press one key (Escape, Enter, Tab, ArrowDown, ...). Enter inside a form is refused on a screen not marked destructive.",
  platforms: ["web"],
  input: { key: z.string().describe("the key, in the browser's key names") },
  mutating: true,
  run: async (args, state) => ({ text: await act(state, { tool: "press", args: { key: args.key }, outcome: {}, at: nowIso() }, args.key) }),
});

export const hover = tool({
  name: "hover",
  description: "Rest the pointer on a control named by its snapshot id, or by role and name, and let what it triggers settle.",
  platforms: ["web"],
  input: control,
  mutating: true,
  run: async (args, state) => {
    const affordance = affordanceOf(args, state);
    return { text: await act(state, { tool: "hover", args: { affordance }, outcome: {}, at: nowIso() }, subjectOf(affordance)) };
  },
});

export const scroll = tool({
  name: "scroll",
  description: "Scroll a control into view (by snapshot id), or scroll the page one screen down or up.",
  platforms: ["web"],
  input: { ...control, direction: z.enum(["down", "up"]).optional() },
  mutating: true,
  run: async (args, state) => {
    if (args.ref || (args.role && args.name)) {
      const affordance = affordanceOf(args, state);
      return { text: await act(state, { tool: "scroll", args: { affordance }, outcome: {}, at: nowIso() }, subjectOf(affordance)) };
    }
    const direction = args.direction ?? "down";
    return { text: await act(state, { tool: "scroll", args: { direction }, outcome: {}, at: nowIso() }, direction) };
  },
});

export const back = tool({
  name: "back",
  description: "Go back one page in the browser's history.",
  platforms: ["web", "android"],
  input: {},
  mutating: true,
  run: async (_args, state) => ({ text: await act(state, { tool: "back", args: {}, outcome: {}, at: nowIso() }, "") }),
});

export const wait = tool({
  name: "wait",
  description: "Wait up to five seconds for something on the screen to settle.",
  platforms: ["web", "ios", "android"],
  input: { ms: z.number().int().min(0).max(5000).describe("milliseconds, at most 5000") },
  mutating: true,
  run: async (args, state) => ({ text: await act(state, { tool: "wait", args: { ms: args.ms }, outcome: {}, at: nowIso() }, `${args.ms}ms`) }),
});

export const arrive = tool({
  name: "arrive",
  description: "Say that the screen you were asked to reach is showing now. lookout photographs it for the record at every form factor and scheme, replaying your actions to get there each time. Call it once; then reply.",
  platforms: ["web", "ios", "android"],
  input: { note: z.string().optional().describe("one plain sentence on how you got here, for a person") },
  mutating: false,
  run: async (args, state) => {
    if (state.arrived) throw new ToolRefusal("the screen has already been captured; reply now");
    if (state.actions.length === 0) throw new ToolRefusal("open the route first");
    state.log.emit("phase", `navigator: arrived at ${state.session.screen.id}; capturing`, { tool: "arrive", screen: state.session.screen.id });
    const arrived = await state.driver.arrive(state.actions);
    state.arrived = arrived;
    const failed = arrived.failures.length > 0 ? `; ${arrived.failures.length} capture failure(s): ${arrived.failures[0]!.message}` : "";
    return { text: `captured ${arrived.shots.length} shot(s) of ${state.session.screen.id}${failed}${args.note ? `\nnoted: ${args.note}` : ""}\nReply now with the JSON the instructions ask for.` };
  },
});

export const WEB_TOOLS: readonly ToolDef<z.ZodRawShape>[] = [snapshot, look, open, click, type, press, hover, scroll, back, wait, arrive] as readonly ToolDef<z.ZodRawShape>[];
