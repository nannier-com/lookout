/**
 * Doing a device recording again: on the device it was recorded on, or on
 * another of the same platform.
 *
 * A tap is re-resolved by the label and id it landed on when the screen can
 * be described, because a control moves between layouts and builds; the
 * coordinates are the fallback, and they transfer only to the same platform
 * and form factor, scaled by width. A tablet is not a wider phone: a tap
 * recorded on one and replayed blind on the other lands on nothing, which is
 * a skip, not a mislabelled photograph.
 */
import type { NativeDevice } from "../capture/native-device.js";
import { NavSkip, NavStateError } from "../navigate/execute.js";
import type { NavAction } from "./actions.js";
import { findNode, type Hierarchy } from "./device-hierarchy.js";

export interface DeviceSize {
  width: number;
  height: number;
}

/**
 * Where a recorded tap lands on this device: the node by label when a
 * hierarchy is at hand, else the recorded point scaled to this width when
 * the recording was made on the same platform and form factor.
 */
export function transferTap(
  action: NavAction,
  device: NativeDevice,
  size: DeviceSize | null,
  hierarchy: Hierarchy | null,
): { x: number; y: number } {
  const a = action.args;
  if (hierarchy && (a.label || a.id)) {
    const node = findNode(hierarchy, a.label ?? "", a.id ?? "");
    if (node) return { x: node.x, y: node.y };
    throw new NavStateError(`"${a.label ?? a.id}" is not on this screen`);
  }
  if (typeof a.x !== "number" || typeof a.y !== "number") throw new NavStateError("the recorded tap names no point");
  const on = a.recordedOn;
  if (!on) return { x: a.x, y: a.y };
  if (on.platform !== device.platform || on.formFactor !== device.formFactor) {
    throw new NavSkip(`a tap recorded on an ${on.platform} ${on.formFactor} does not transfer to this ${device.platform} ${device.formFactor}`);
  }
  if (!size || on.width === 0) return { x: a.x, y: a.y };
  const scale = size.width / on.width;
  return { x: a.x * scale, y: a.y * scale };
}

/** What a device driver has to offer a replay: one action at a time, and a fresh description when it can. */
export interface DeviceActor {
  device: NativeDevice;
  size: DeviceSize | null;
  describe(): Promise<Hierarchy | null>;
  perform(action: NavAction, at?: { x: number; y: number }): Promise<void>;
}

/** Run a recording on a device, taps re-resolved as they go. */
export async function replayDevice(actor: DeviceActor, actions: readonly NavAction[]): Promise<void> {
  for (const action of actions) {
    if (action.tool === "open") continue;
    if (action.tool === "tap") {
      const hierarchy = action.args.label || action.args.id ? await actor.describe() : null;
      await actor.perform(action, transferTap(action, actor.device, actor.size, hierarchy));
      continue;
    }
    await actor.perform(action);
  }
}
