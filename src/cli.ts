#!/usr/bin/env bun
/**
 * lookout: a project-agnostic visual AI tester.
 *
 * Verbs:
 *   protocol  the operating contract, printed by lookout for whichever agent runs it
 *   capture   screenshots + deterministic findings, no AI
 *   check     capture + judge against best practices; findings merge into the backlog
 *   verify-fix rule on a claimed fix: re-capture, re-judge, pass it or hand it back
 *   verify    judge captured evidence against acceptance criteria from a ticket
 *   ask       answer a free-form question about the rendered app, with evidence
 *   backlog   adjudicate findings (merge / set / reopen / regen / check / stats)
 *   skills    lookout's own instructions: list, freeze, replay, improve
 *   targets   list configured targets and probe reachability
 *   init      scaffold .lookout/config.ts in this repo
 *   status    what the run in flight is doing, from the event log
 *   ui        a local page rendering that same log, live, for a person
 *   doctor    check prerequisites (claude CLI, chromium, sharp, simctl, adb)
 *   self-heal fix what lookout keeps getting wrong, in lookout's own source
 *
 * Exit codes: 0 clean, 1 findings or failed criteria or failing checks,
 * 2 execution error. verify-fix adds 3 for an issue blocked after exhausting
 * its attempts.
 */
import { recordIncident } from "./skills/incidents.js";
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
    summary: "capture + AI judge; findings merge into the backlog",
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
    summary: "adjudicate findings (merge/set/reopen/regen/check/stats)",
  },
  skills: {
    load: async () => (await import("./verbs/skills.js")).skills,
    summary: "what lookout knows how to judge, and how it learns (list/freeze/replay/improve)",
  },
  "self-heal": {
    load: async () => (await import("./verbs/self-heal.js")).selfHeal,
    summary: "fix what lookout keeps getting wrong, in lookout's own source",
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
      "\nexamples:" +
      "\n  lookout targets --url http://localhost:3000" +
      "\n  lookout capture --targets app --routes /,/settings" +
      "\n  lookout check" +
      "\n  lookout verify-fix --issue 418203 --commit <sha>" +
      '\n  lookout verify --criteria ticket.md --targets app' +
      '\n  lookout ask "does the sidebar collapse below 640px?" --targets app' +
      "\n\nlookout is run by agents, of any make. Run `lookout protocol` for the" +
      "\nfull operating contract; it is the tool's own instructions, not a plugin.",
  );
}

/**
 * Running from a source checkout with a build older than the source.
 *
 * The published package ships `dist` alone, so this only ever fires for someone
 * running out of the repository. It exists because a stale build is invisible:
 * the code runs, it just is not the code you wrote, and every symptom points
 * somewhere else. That cost real time before this check existed.
 */
function warnIfStale(): void {
  void (async () => {
    try {
      const { statSync, existsSync, readdirSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const distDir = dirname(fileURLToPath(import.meta.url));
      const srcDir = join(distDir, "..", "src");
      if (!existsSync(srcDir)) return;

      let newestSrc = 0;
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".ts")) {
            const t = statSync(p).mtimeMs;
            if (t > newestSrc) newestSrc = t;
          }
        }
      };
      walk(srcDir);
      const built = statSync(join(distDir, "cli.js")).mtimeMs;
      if (newestSrc > built) {
        const mins = Math.round((newestSrc - built) / 60000);
        console.error(
          `lookout: this build is stale; source changed ${mins} minute(s) after it was compiled.\n` +
            "  run `bun run build`, and restart anything already running: a server\n" +
            "  holds the old code in memory until it does.",
        );
      }
    } catch {
      // A warning that cannot be produced is not worth failing a run over.
    }
  })();
}

async function main(): Promise<number> {
  warnIfStale();
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
    // Written down before it is printed. `events.jsonl` is truncated by the
    // next capture, so without this the failure is gone by the time anybody
    // could act on it, and `lookout self-heal` would have nothing to read.
    const verb = process.argv[2];
    if (err instanceof LookoutError) {
      recordIncident({
        at: new Date().toISOString(),
        kind: "operator-error",
        verb,
        message: err.message,
        ...(err.hint ? { detail: err.hint } : {}),
        project: process.cwd(),
      });
      console.error(`lookout: ${err.message}`);
      if (err.hint) console.error(`  hint: ${err.hint}`);
    } else {
      recordIncident({
        at: new Date().toISOString(),
        kind: "crash",
        verb,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack ? { detail: err.stack.slice(0, 2000) } : {}),
        project: process.cwd(),
      });
      console.error("lookout: unexpected error");
      console.error(err);
    }
    process.exit(2);
  });
