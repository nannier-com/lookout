#!/usr/bin/env bun
/**
 * lookout's navigation tool server, started by an AI's CLI for one session:
 * `mcp.js --session <absolute path>`. Everything it needs is in that file;
 * everything it learned is left there when it exits.
 *
 * stdout is the protocol. Anything lookout's own modules print goes to
 * stderr instead, because one stray line on stdout is a broken conversation.
 */
import { serveSession } from "./mcp/server.js";

console.log = (...args: unknown[]): void => {
  console.error(...args);
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--session");
  const sessionPath = at === -1 ? undefined : argv[at + 1];
  if (!sessionPath) {
    console.error("usage: lookout-mcp --session <path>");
    return 2;
  }
  await serveSession(sessionPath);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`lookout mcp: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
