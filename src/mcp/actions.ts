/**
 * What a navigator did to reach a screen, written down so lookout can do it
 * again without asking: at every form factor and scheme when the screen is
 * captured, and on every later run until the app changes under it.
 *
 * An action names its target the way a later capture can find it again (a
 * control by role and accessible name, a tap by the label it landed on and
 * the device it was recorded on), never by a snapshot reference, which is an
 * id minted for one snapshot and meaningless after it.
 */
import type { AffordanceRef } from "../navigate/store.js";
import type { DeviceKind } from "../types.js";

export type NavTool =
  | "open"
  | "click"
  | "type"
  | "press"
  | "hover"
  | "scroll"
  | "back"
  | "tap"
  | "swipe"
  | "key"
  | "wait";

export interface NavAction {
  tool: NavTool;
  args: {
    /** `open`: the route path on the target. */
    path?: string;
    /** Web: the control acted on, resolved from the snapshot at the time. */
    affordance?: AffordanceRef;
    text?: string;
    key?: string;
    direction?: "up" | "down";
    ms?: number;
    /** Devices: where a tap or the start of a swipe landed. */
    x?: number;
    y?: number;
    /** Devices: the label and id of the node under the tap, for re-resolving it. */
    label?: string;
    id?: string;
    from?: { x: number; y: number };
    to?: { x: number; y: number };
    durationMs?: number;
    /** What device the coordinates were recorded on, so replay knows when they transfer. */
    recordedOn?: { platform: "ios" | "android"; formFactor: DeviceKind; width: number; height: number };
  };
  /** What the tool observed after acting: the replay guard. */
  outcome: { url?: string; navigated?: boolean };
  at: string;
}

/**
 * What the screen looked like when the navigator said it had arrived: the
 * affordance signature and a few control names, so a replay can tell the
 * screen it reached from the one it was meant to reach.
 */
export interface Arrival {
  url?: string;
  signature?: string;
  sampleNames: string[];
}
