#!/usr/bin/env bun
/**
 * lookout: a project-agnostic visual AI tester.
 *
 * Verbs:
 *   capture   screenshots + deterministic findings, no AI
 *   check     capture + judge against best practices; findings merge into the backlog
 *   verify    judge captured evidence against acceptance criteria from a ticket
 *   ask       answer a free-form question about the rendered app, with evidence
 *   backlog   adjudicate findings (merge / set / reopen / regen / check / stats)
 *   targets   list configured targets and probe reachability
 *   init      scaffold .lookout/config.ts in this repo
 *   doctor    check prerequisites (claude CLI, chromium, sharp, simctl, adb)
 *
 * Exit codes: 0 clean, 1 findings or failed criteria or failing checks,
 * 2 execution error.
 */
import { LookoutError } from "./types.js";
import { parseFlags, type Parsed } from "./util.js";

type Verb = (parsed: Parsed) => Promise<number>;

// Verbs register here as their phases land; the registry is the single source
// for dispatch and help.
const VERBS: Record<string, { load: () => Promise<Verb>; summary: string }> = {
  capture: {
    load: async () => (await import("./verbs/capture.js")).capture,
    summary: "screenshots + deterministic findings, no AI",
  },
  check: {
    load: async () => (await import("./verbs/check.js")).check,
    summary: "capture + AI judge against best practices",
  },
  ask: {
    load: async () => (await import("./verbs/ask.js")).ask,
    summary: "answer a question about the rendered app, with evidence",
  },
  targets: {
    load: async () => (await import("./verbs/targets.js")).targets,
    summary: "list configured targets and probe reachability",
  },
  init: {
    load: async () => (await import("./verbs/init.js")).init,
    summary: "scaffold .lookout/config.ts in this repo",
  },
  doctor: {
    load: async () => (await import("./verbs/doctor.js")).doctor,
    summary: "check prerequisites (claude, chromium, sharp, simctl, adb)",
  },
};

function help(): void {
  console.log("lookout <verb> [flags]\n");
  for (const [name, v] of Object.entries(VERBS)) {
    console.log(`  ${name.padEnd(9)} ${v.summary}`);
  }
  console.log(
    "\ncommon flags: --config <path> --url <base> --targets a,b --routes /x,/y" +
      "\n              --json --allow-remote" +
      "\nexamples:" +
      "\n  lookout targets --url http://localhost:8081" +
      "\n  lookout capture --targets docs --routes /components/button" +
      '\n  lookout verify --criteria ticket.md --targets app' +
      '\n  lookout ask "does the sidebar collapse below 640px?" --targets app',
  );
}

async function main(): Promise<number> {
  const [verbName, ...rest] = process.argv.slice(2);
  if (!verbName || verbName === "help" || verbName === "--help" || verbName === "-h") {
    help();
    return verbName ? 0 : 2;
  }
  if (verbName === "--version" || verbName === "-v") {
    // Read rather than import: a JSON import would drag package.json into the
    // compile rootDir and shift dist/cli.js to dist/src/cli.js.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    console.log(pkg.version ?? "unknown");
    return 0;
  }
  const entry = VERBS[verbName];
  if (!entry) {
    console.error(`unknown verb "${verbName}"\n`);
    help();
    return 2;
  }
  const verb = await entry.load();
  return verb(parseFlags(rest));
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof LookoutError) {
      console.error(`lookout: ${err.message}`);
      if (err.hint) console.error(`  hint: ${err.hint}`);
    } else {
      console.error("lookout: unexpected error");
      console.error(err);
    }
    process.exit(2);
  });
