#!/usr/bin/env bun
/**
 * lookout: a project-agnostic visual AI tester.
 *
 * Verbs:
 *   protocol  the operating contract, printed by lookout for whichever agent runs it
 *   capture   screenshots + deterministic findings, no AI
 *   check     capture + judge against best practices; findings merge into the backlog
 *             (--auto also writes one fix brief per root cause for dispatch)
 *   verify-fix rule on a claimed fix: re-capture, re-judge, pass it or hand it back
 *   verify    judge captured evidence against acceptance criteria from a ticket
 *   ask       answer a free-form question about the rendered app, with evidence
 *   backlog   adjudicate findings (merge / set / reopen / regen / check / stats)
 *   targets   list configured targets and probe reachability
 *   init      scaffold .lookout/config.ts in this repo
 *   status    what the run in flight is doing, from the event log
 *   ui        a local page rendering that same log, live, for a person
 *   doctor    check prerequisites (claude CLI, chromium, sharp, simctl, adb)
 *
 * Exit codes: 0 clean, 1 findings or failed criteria or failing checks,
 * 2 execution error. verify-fix adds 3 for a cluster blocked after exhausting
 * its attempts.
 */
import { LookoutError } from "./types.js";
import { parseFlags, type Parsed } from "./util.js";

type Verb = (parsed: Parsed) => Promise<number>;

// Verbs register here as their phases land; the registry is the single source
// for dispatch and help.
const VERBS: Record<string, { load: () => Promise<Verb>; summary: string }> = {
  protocol: {
    load: async () => (await import("./verbs/protocol.js")).protocol,
    summary: "how to drive lookout: the operating contract, for any agent",
  },
  capture: {
    load: async () => (await import("./verbs/capture.js")).capture,
    summary: "screenshots + deterministic findings, no AI",
  },
  check: {
    load: async () => (await import("./verbs/check.js")).check,
    summary: "capture + AI judge; --auto writes fix briefs to dispatch",
  },
  "verify-fix": {
    load: async () => (await import("./verbs/verify-fix.js")).verifyFix,
    summary: "rule on a claimed fix: re-judge, pass it or hand it back",
  },
  ask: {
    load: async () => (await import("./verbs/ask.js")).ask,
    summary: "answer a question about the rendered app, with evidence",
  },
  verify: {
    load: async () => (await import("./verbs/verify.js")).verify,
    summary: "judge the app against acceptance criteria (--criteria)",
  },
  backlog: {
    load: async () => (await import("./verbs/backlog.js")).backlog,
    summary: "adjudicate findings (merge/set/plan/regen/check/stats)",
  },
  targets: {
    load: async () => (await import("./verbs/targets.js")).targets,
    summary: "list configured targets and probe reachability",
  },
  init: {
    load: async () => (await import("./verbs/init.js")).init,
    summary: "scaffold .lookout/config.ts in this repo",
  },
  status: {
    load: async () => (await import("./verbs/status.js")).status,
    summary: "what the run in flight is doing (poll this while check runs)",
  },
  ui: {
    load: async () => (await import("./verbs/ui.js")).ui,
    summary: "a local page showing the run live, for a person to watch",
  },
  doctor: {
    load: async () => (await import("./verbs/doctor.js")).doctor,
    summary: "check prerequisites (claude, chromium, sharp, simctl, adb)",
  },
};

function help(): void {
  console.log("lookout <verb> [flags]\n");
  for (const [name, v] of Object.entries(VERBS)) {
    console.log(`  ${name.padEnd(10)} ${v.summary}`);
  }
  console.log(
    "\ncommon flags: --config <path> --url <base> --targets a,b --routes /x,/y" +
      "\n              --json --allow-remote" +
      "\nauto flags:   --auto --severity critical|high|medium|low --max-attempts <n>" +
      "\nexamples:" +
      "\n  lookout targets --url http://localhost:8081" +
      "\n  lookout capture --targets docs --routes /components/button" +
      "\n  lookout check --auto" +
      "\n  lookout verify-fix --cluster app--contrast--body-text --commit <sha>" +
      '\n  lookout verify --criteria ticket.md --targets app' +
      '\n  lookout ask "does the sidebar collapse below 640px?" --targets app' +
      "\n\nlookout is run by agents, of any make. Run `lookout protocol` for the" +
      "\nfull operating contract; it is the tool's own instructions, not a plugin.",
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
