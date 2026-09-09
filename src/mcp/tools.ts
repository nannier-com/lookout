/**
 * The registry: every navigation tool lookout ships, and which of them a
 * session on a given platform is offered. The names are what the adapters
 * allow-list, so they are derived from the definitions rather than typed
 * twice. A name may be defined once per platform family (`type` on the web
 * fills a field by name; on a device it types into the focused one); a
 * session sees exactly one of them.
 */
import type { z } from "zod";
import type { PlatformKind } from "../types.js";
import type { ToolDef } from "./tool.js";
import { DEVICE_TOOLS } from "./tools-device.js";
import { WEB_TOOLS } from "./tools-web.js";

/** Every tool, whatever the platform. */
export const ALL_TOOLS: readonly ToolDef<z.ZodRawShape>[] = [...WEB_TOOLS, ...DEVICE_TOOLS];

export const TOOL_NAMES: readonly string[] = [...new Set(ALL_TOOLS.map((t) => t.name))];

/** The tools a session on this platform is offered, one per name. */
export function toolsFor(platform: PlatformKind): ToolDef<z.ZodRawShape>[] {
  const seen = new Set<string>();
  return ALL_TOOLS.filter((t) => {
    if (!t.platforms.includes(platform) || seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}
