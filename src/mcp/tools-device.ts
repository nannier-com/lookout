/**
 * The tools a navigator has on a simulator or an emulator. A tap names a
 * node from the last snapshot, or a point in the screen's own coordinates;
 * either way the recording keeps the label and id the tap landed on, so a
 * replay can find the control again where a coordinate would miss.
 */
import { z } from "zod";
import { nowIso } from "../util.js";
import { ToolRefusal } from "./driver.js";
import { actAndSnapshot as act, tool, type ToolDef, type ToolState } from "./tool.js";

function nodeOf(args: { ref?: string; x?: number; y?: number }, state: ToolState): { x: number; y: number; label?: string; id?: string } {
  if (args.ref) {
    const hit = state.snapshot?.refs.get(args.ref);
    if (!hit) throw new ToolRefusal(`no ${JSON.stringify(args.ref)} in the last snapshot; call snapshot first`);
    if (hit.kind !== "node") throw new ToolRefusal(`${args.ref} is a web control, not a device node`);
    return { x: hit.x, y: hit.y, label: hit.label, id: hit.id };
  }
  if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y };
  throw new ToolRefusal("name the node: a ref from the last snapshot, or x and y in the screen's coordinates");
}

const point = { x: z.number(), y: z.number() };

export const tap = tool({
  name: "tap",
  description: "Tap a node named by its snapshot id, or a point (x, y) in the screen's own coordinates. Answers with the new snapshot.",
  platforms: ["ios", "android"],
  input: {
    ref: z.string().optional().describe("a node's id from the last snapshot (n1, n2, ...)"),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  mutating: true,
  run: async (args, state) => {
    const node = nodeOf(args, state);
    const subject = node.label ? JSON.stringify(node.label) : `(${node.x}, ${node.y})`;
    return { text: await act(state, { tool: "tap", args: { ...node }, outcome: {}, at: nowIso() }, subject) };
  },
});

export const swipe = tool({
  name: "swipe",
  description: "Drag from one point to another in the screen's own coordinates, over durationMs (default 300).",
  platforms: ["ios", "android"],
  input: { from: z.object(point), to: z.object(point), durationMs: z.number().int().min(50).max(5000).optional() },
  mutating: true,
  run: async (args, state) => ({
    text: await act(state, { tool: "swipe", args: { from: args.from, to: args.to, durationMs: args.durationMs ?? 300 }, outcome: {}, at: nowIso() }, `${args.from.x},${args.from.y} to ${args.to.x},${args.to.y}`),
  }),
});

export const key = tool({
  name: "key",
  description: "Press one key by name (Enter, Escape, Backspace, Tab, ArrowDown, ...; on Android also Back and Home).",
  platforms: ["ios", "android"],
  input: { key: z.string() },
  mutating: true,
  run: async (args, state) => ({ text: await act(state, { tool: "key", args: { key: args.key }, outcome: {}, at: nowIso() }, args.key) }),
});

export const typeText = tool({
  name: "type",
  description: "Type text into whatever field has the keyboard focus; tap the field first.",
  platforms: ["ios", "android"],
  input: { text: z.string() },
  mutating: true,
  run: async (args, state) => ({ text: await act(state, { tool: "type", args: { text: args.text }, outcome: {}, at: nowIso() }, JSON.stringify(args.text.slice(0, 40))) }),
});

export const DEVICE_TOOLS: readonly ToolDef<z.ZodRawShape>[] = [tap, swipe, key, typeText] as readonly ToolDef<z.ZodRawShape>[];
