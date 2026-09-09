/**
 * Where the tool server is and what it is called, in one place, so neither
 * AI adapter learns a path. An adapter asks for the server spec and spells it
 * the way its CLI wants (`--mcp-config` for one, `-c mcp_servers.*` for the
 * other).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LookoutError } from "../types.js";
import { TOOL_NAMES } from "./tools.js";

/** The server's name: what the CLIs prefix the tools with (`mcp__lookout__click`). */
export const SERVER_NAME = "lookout";

/** The server's entry: `mcp.js` beside `dist/`'s modules, or `mcp.ts` when running from source. */
export function mcpEntry(): string {
  const built = fileURLToPath(new URL("../mcp.js", import.meta.url));
  if (existsSync(built)) return built;
  const source = fileURLToPath(new URL("../mcp.ts", import.meta.url));
  if (existsSync(source)) return source;
  throw new LookoutError("lookout's navigation tool server is missing", `expected ${built}; reinstall lookout`);
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
}

/** How to start the server for one session. `process.execPath` is bun, which is what runs lookout. */
export function mcpServerSpec(sessionPath: string): McpServerSpec {
  return { name: SERVER_NAME, command: process.execPath, args: [mcpEntry(), "--session", sessionPath] };
}

export function mcpToolNames(): readonly string[] {
  return TOOL_NAMES;
}
