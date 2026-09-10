/**
 * What is on a device's screen, read off the platform's own description of
 * it: Android's `uiautomator dump` XML, iOS's `idb ui describe-all` JSON.
 * Parsing is pure and kept apart from running the tools, so it is tested on
 * canned output on a machine with neither an emulator nor a simulator.
 *
 * Coordinates are in the space the platform taps in: pixels on Android
 * (`input tap` takes pixels, and the dump's bounds are pixels), points on
 * iOS (`idb ui tap` takes points, and the accessibility frames are points).
 */
import type { RefTarget } from "./driver.js";

export type DeviceRef = Extract<RefTarget, { kind: "node" }> & { role: string };

export interface Hierarchy {
  refs: Map<string, DeviceRef>;
  /** The screen's size in the tap coordinate space, when the root node says. */
  size: { width: number; height: number } | null;
}

const ANDROID_ROLE: Record<string, string> = {
  "android.widget.Button": "button",
  "android.widget.ImageButton": "button",
  "android.widget.EditText": "textfield",
  "android.widget.CheckBox": "checkbox",
  "android.widget.Switch": "switch",
  "android.widget.RadioButton": "radio",
  "android.widget.TextView": "text",
  "android.widget.ImageView": "image",
};

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : null;
}

function bounds(text: string | null): { x: number; y: number; w: number; h: number } | null {
  const m = text ? /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(text) : null;
  if (!m) return null;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Why a platform would not describe its screen, in words a model can act on,
 * or null when the output is a description.
 *
 * Android's uiautomator waits for the app to go idle and refuses when it does
 * not, which an app with a running animation never does: measured on a React
 * Native home screen with an animated background, where every dump answered
 * "ERROR: could not get idle state." A model handed an empty node list and no
 * reason falls back to guessing coordinates off a picture, which is how a
 * navigator came to tap the same spot five times and give up.
 */
export function describeFailure(raw: string): string | null {
  const text = raw.trim();
  if (/could not get idle state/i.test(text)) {
    return "this screen never stops moving (an animation is running), so the platform will not describe it";
  }
  if (/^ERROR/i.test(text)) return `the platform would not describe this screen: ${text.split("\n")[0]!.slice(0, 160)}`;
  if (text.length === 0) return "the platform described nothing at all";
  return null;
}

/** The display's pixel size, from `wm size`: the space Android taps land in. An override wins over the physical size. */
export function sizeOfWmSize(out: string): { width: number; height: number } | null {
  const last = [...out.matchAll(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)].pop();
  return last ? { width: Number(last[1]), height: Number(last[2]) } : null;
}

/**
 * The tappable nodes of a uiautomator dump: clickable, or carrying a label a
 * person would tap by, with a non-empty box. Ids are minted in document
 * order, `n1, n2, ...`, and mean nothing outside the snapshot they came from.
 */
export function refsOfUiautomator(xml: string): Hierarchy {
  const refs = new Map<string, DeviceRef>();
  let size: Hierarchy["size"] = null;
  let n = 0;
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = m[0];
    const box = bounds(attr(tag, "bounds"));
    if (!box || box.w < 1 || box.h < 1) continue;
    if (size === null && attr(tag, "index") === "0" && box.x === 0 && box.y === 0) size = { width: box.w, height: box.h };
    const clickable = attr(tag, "clickable") === "true";
    const label = attr(tag, "content-desc") || attr(tag, "text") || "";
    if (!clickable && !label) continue;
    const cls = attr(tag, "class") ?? "";
    const role = ANDROID_ROLE[cls] ?? (clickable ? "button" : "text");
    if (!clickable && role === "text" && label.length > 80) continue;
    n++;
    refs.set(`n${n}`, {
      kind: "node",
      x: Math.round(box.x + box.w / 2),
      y: Math.round(box.y + box.h / 2),
      label: label.slice(0, 80),
      id: attr(tag, "resource-id") ?? "",
      bounds: box,
      role,
    });
  }
  return { refs, size };
}

interface IdbElement {
  frame?: { x?: number; y?: number; width?: number; height?: number };
  AXLabel?: string | null;
  title?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  type?: string | null;
  role_description?: string | null;
  enabled?: boolean;
  children?: IdbElement[];
}

const IOS_INTERACTIVE = new Set(["Button", "Link", "TextField", "SecureTextField", "Switch", "Cell", "Tab", "SearchField", "Slider", "Toggle", "MenuItem", "TabBar"]);

/**
 * The tappable elements of an accessibility description: the interactive
 * types, plus anything labelled that is enabled. Nested trees are walked;
 * flat lists (what `describe-all` prints) are read as they are.
 */
export function refsOfIdb(json: string): Hierarchy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { refs: new Map(), size: null };
  }
  const refs = new Map<string, DeviceRef>();
  let size: Hierarchy["size"] = null;
  let n = 0;
  const visit = (el: IdbElement): void => {
    const f = el.frame;
    const box = f && typeof f.x === "number" && typeof f.y === "number" ? { x: f.x, y: f.y, w: f.width ?? 0, h: f.height ?? 0 } : null;
    if (box && size === null && box.x === 0 && box.y === 0 && box.w > 0 && box.h > 0) size = { width: box.w, height: box.h };
    const type = el.type ?? "";
    const label = (el.AXLabel || el.title || el.AXValue || "").toString();
    if (box && box.w >= 1 && box.h >= 1 && el.enabled !== false && (IOS_INTERACTIVE.has(type) || (label && type !== "Application" && type !== "Window"))) {
      n++;
      refs.set(`n${n}`, {
        kind: "node",
        x: Math.round(box.x + box.w / 2),
        y: Math.round(box.y + box.h / 2),
        label: label.slice(0, 80),
        id: el.AXUniqueId ?? "",
        bounds: box,
        role: (el.role_description || type || "element").toString().toLowerCase(),
      });
    }
    for (const child of el.children ?? []) visit(child);
  };
  for (const el of Array.isArray(parsed) ? (parsed as IdbElement[]) : [parsed as IdbElement]) visit(el);
  return { refs, size };
}

/** The hierarchy as the model reads it: one line per node, by reference id. */
export function hierarchyText(h: Hierarchy, header: string): string {
  const lines = [header];
  if (h.size) lines.push(`screen: ${h.size.width}x${h.size.height} (tap coordinates)`);
  lines.push("");
  if (h.refs.size === 0) lines.push("(no tappable nodes were described)");
  for (const [id, r] of h.refs) {
    lines.push(`- ${id} [${r.role}] ${JSON.stringify(r.label)}${r.id ? ` id=${r.id}` : ""} at (${r.x}, ${r.y})`);
  }
  return lines.join("\n");
}

/** The node a tap by label lands on, in a fresh hierarchy: exact label, then the same id, then a prefix. */
export function findNode(h: Hierarchy, label: string, id: string): DeviceRef | null {
  const all = [...h.refs.values()];
  return (
    all.find((r) => r.label === label && (!id || r.id === id)) ??
    (id ? all.find((r) => r.id === id) : undefined) ??
    all.find((r) => label && r.label.startsWith(label)) ??
    null
  );
}

/** USB HID usage ids, what `idb ui key` takes. */
const HID_KEYS: Record<string, number> = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
};

/** A key name as iOS wants it: a HID usage id, or null for a name lookout does not know. */
export function iosKeyCode(key: string): number | null {
  if (/^\d+$/.test(key)) return Number(key);
  return HID_KEYS[key] ?? null;
}

const ANDROID_KEYS: Record<string, string> = {
  Enter: "KEYCODE_ENTER", Escape: "KEYCODE_ESCAPE", Backspace: "KEYCODE_DEL", Tab: "KEYCODE_TAB", Space: "KEYCODE_SPACE",
  ArrowRight: "KEYCODE_DPAD_RIGHT", ArrowLeft: "KEYCODE_DPAD_LEFT", ArrowDown: "KEYCODE_DPAD_DOWN", ArrowUp: "KEYCODE_DPAD_UP",
  Back: "KEYCODE_BACK", Home: "KEYCODE_HOME",
};

/** A key name as Android wants it: a KEYCODE_ constant, passed through when already one. */
export function androidKeyCode(key: string): string | null {
  if (/^KEYCODE_[A-Z0-9_]+$/.test(key) || /^\d+$/.test(key)) return key;
  return ANDROID_KEYS[key] ?? null;
}
