/**
 * The registry: every navigation tool lookout ships, and which of them a
 * session on a given platform is offered. The names are what the adapters
 * allow-list, so they are derived from the definitions rather than typed
 * twice.
 */
import type { z } from "zod";
import type { PlatformKind } from "../types.js";
import type { ToolDef } from "./tool.js";
import { WEB_TOOLS } from "./tools-web.js";

/** Every tool, whatever the platform; a name appears once. */
export const ALL_TOOLS: readonly ToolDef<z.ZodRawShape>[] = [...WEB_TOOLS];

export const TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);

/** The tools a session on this platform is offered. */
export function toolsFor(platform: PlatformKind): ToolDef<z.ZodRawShape>[] {
  return ALL_TOOLS.filter((t) => t.platforms.includes(platform));
}
