/**
 * What every platform the navigator can drive has to offer: a way to open a
 * screen, to see what is on it, to act on it, and to hand the screen to
 * lookout's capture once the navigator says it has arrived.
 *
 * One interface, three drivers (web, iOS, Android), so the tools above it
 * never know which platform they are on. The drivers share nothing else: a
 * browser page and a simulator have no common vocabulary below this line.
 */
import type { EventLog } from "../report/events.js";
import type { PlatformKind, ResolvedConfig, ShotRecord, TargetDef } from "../types.js";
import type { Affordance } from "../navigate/store.js";
import type { Arrival, NavAction } from "./actions.js";
import type { NavSession } from "./session.js";

/** What a snapshot reference points at: a web control, or a node on a device screen. */
export type RefTarget =
  | { kind: "web"; affordance: Affordance }
  | { kind: "node"; x: number; y: number; label: string; id: string; bounds: { x: number; y: number; w: number; h: number } };

export interface Snapshot {
  /** What the model reads: one line per control, by reference id. */
  text: string;
  refs: Map<string, RefTarget>;
  /** A picture, when the platform cannot describe the screen in words. */
  image?: Buffer;
  /** What this screen looks like to a later replay, for recognising it. */
  arrival: Arrival;
}

export interface Arrived {
  shots: ShotRecord[];
  failures: { step: string; message: string }[];
  arrival: Arrival;
}

export interface Driver {
  readonly platform: PlatformKind;
  /** Reach the screen's route and replay the prelude; the navigator starts from here. */
  open(path: string): Promise<NavAction["outcome"]>;
  snapshot(): Promise<Snapshot>;
  /** One picture of the screen as it is, for the model's own eyes; never a capture record. */
  look(): Promise<Buffer>;
  /** Perform one action live. Throws `ToolRefusal` for anything the rules forbid. */
  act(action: NavAction): Promise<NavAction["outcome"]>;
  /** Run a recording again, checking each step against what it recorded; throws when the screen differs. */
  replay(actions: readonly NavAction[]): Promise<void>;
  /** Photograph the screen for the record, across the matrix, using the actions that reached it. */
  arrive(actions: NavAction[]): Promise<Arrived>;
  close(): Promise<void>;
}

export interface DriverContext {
  session: NavSession;
  resolved: ResolvedConfig;
  target: TargetDef;
  log: EventLog;
}

/**
 * What a tool answers when it will not do something: the reason, as the
 * model's tool result with `isError`, never a protocol error. The model reads
 * it and chooses differently; a protocol error would end the conversation.
 */
export class ToolRefusal extends Error {}
