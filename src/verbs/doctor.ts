/**
 * `lookout doctor`: report whether the machine can run each part of lookout.
 *
 * Required for judging: the local Claude Code CLI. Required for web capture:
 * Playwright's chromium. Optional: simctl (iOS) and adb (Android) for native
 * capture. Checks are cheap and offline; `--handshake` additionally runs one
 * real `claude -p` round-trip (it spends a small amount of the user's quota,
 * so it is opt-in).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOOKOUT_DIR } from "../config-locate.js";
import { execFileAsync, printJson, row, str } from "../util.js";
import type { Parsed } from "../util.js";

interface Check {
  name: string;
  required: boolean;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function version(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
    return stdout.trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

export async function doctor(parsed: Parsed): Promise<number> {
  const checks: Check[] = [];

  // bun: the runtime that makes TypeScript configs first-class.
  checks.push({
    name: "bun",
    required: true,
    ok: !!process.versions.bun,
    detail: process.versions.bun ? `v${process.versions.bun}` : "not the active runtime",
    fix: "install bun (https://bun.sh) and run lookout via bun/bunx",
  });

  // Claude Code CLI: the judge engine.
  const claudeV = await version("claude", ["--version"]);
  checks.push({
    name: "claude",
    required: true,
    ok: claudeV !== null,
    detail: claudeV ?? "not found on PATH",
    fix: "install Claude Code (https://claude.com/claude-code); judging shells out to `claude -p`",
  });

  // Playwright chromium: the web camera.
  let chromiumDetail = "unknown";
  let chromiumOk = false;
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    chromiumOk = !!exe && existsSync(exe);
    chromiumDetail = chromiumOk ? exe : "browser not downloaded";
  } catch (e) {
    chromiumDetail = `playwright failed to load: ${(e as Error).message}`;
  }
  checks.push({
    name: "chromium",
    required: true,
    ok: chromiumOk,
    detail: chromiumDetail,
    fix: "bunx playwright install chromium",
  });

  // sharp: image cropping/hashing.
  let sharpOk = false;
  let sharpDetail = "";
  try {
    const sharp = (await import("sharp")).default;
    sharpDetail = `v${sharp.versions?.sharp ?? "?"}`;
    sharpOk = true;
  } catch (e) {
    sharpDetail = (e as Error).message;
  }
  checks.push({ name: "sharp", required: true, ok: sharpOk, detail: sharpDetail });

  // Native tooling (optional; only needed for `lookout capture --platforms=ios,android`).
  if (process.platform === "darwin") {
    const simctl = await version("xcrun", ["simctl", "help"]);
    checks.push({
      name: "simctl",
      required: false,
      ok: simctl !== null,
      detail: simctl !== null ? "available" : "xcrun simctl not available",
      fix: "install Xcode command line tools for iOS simulator capture",
    });
  }
  // A directory an older lookout kept its state in. Reported, never touched:
  // lookout does not delete an operator's files, and it is the only place the
  // tool still mentions the home it used to have.
  const stale = join(homedir(), LOOKOUT_DIR);
  if (existsSync(stale)) {
    checks.push({
      name: "~/.lookout",
      required: false,
      ok: true,
      detail: `left over from an older lookout; nothing reads it, and it is safe to delete (${stale})`,
    });
  }

  const adbPath = process.env.ADB ?? "adb";
  const adb = await version(adbPath, ["version"]);
  checks.push({
    name: "adb",
    required: false,
    ok: adb !== null,
    detail: adb ?? `${adbPath} not found (set ADB=/path/to/adb)`,
    fix: "install Android platform-tools for emulator capture",
  });

  // Optional real round-trip through the judge.
  if (parsed.flags.handshake) {
    const model = str(parsed.flags.model);
    const args = ["-p", "Reply with exactly the word ok.", "--output-format", "json"];
    if (model) args.push("--model", model);
    try {
      const { stdout } = await execFileAsync("claude", args, { timeout: 120_000 });
      const parsedOut = JSON.parse(stdout) as { result?: string };
      const ok = typeof parsedOut.result === "string" && /\bok\b/i.test(parsedOut.result);
      checks.push({
        name: "handshake",
        required: true,
        ok,
        detail: ok ? "claude -p JSON round-trip succeeded" : `unexpected reply: ${stdout.slice(0, 120)}`,
      });
    } catch (e) {
      checks.push({
        name: "handshake",
        required: true,
        ok: false,
        detail: (e as Error).message.slice(0, 200),
        fix: "run `claude` interactively once to complete login, then retry",
      });
    }
  }

  const requiredFailing = checks.filter((c) => c.required && !c.ok);

  // lookout itself: the record of its own failures. Doctor is the human verb,
  // which makes it where a MANUAL verb's nudge belongs; nothing here runs
  // anything. Two sources, because doctor is one of the two readers that
  // legitimately spans projects: the project it was run in, when that is one,
  // and lookout's own checkout, which holds the failures that happened with no
  // project in scope.
  const { activeGroups, readHeals } = await import("../skills/heal-select.js");
  const { incidentSources, readIncidentsFrom } = await import("../skills/incidents.js");
  const { locateConfig } = await import("../config-locate.js");
  const { ownCheckout } = await import("../checkout.js");
  const sources = incidentSources(locateConfig(process.cwd())?.projectDir, ownCheckout());
  const groups = activeGroups(readIncidentsFrom(sources), readHeals(ownCheckout()));
  const hot = groups.filter((g) => g.recurred || g.count >= 3);
  const self = {
    sources,
    activeGroups: groups.length,
    hot: hot.length,
    top: groups[0]
      ? {
          kind: groups[0].kind,
          message: groups[0].message,
          count: groups[0].count,
          lastSeen: groups[0].latest.at,
          recurred: groups[0].recurred,
        }
      : null,
  };

  if (parsed.flags.json) {
    printJson({ ok: requiredFailing.length === 0, checks, self });
  } else {
    console.log("lookout doctor\n");
    for (const c of checks) {
      const mark = c.ok ? "ok " : c.required ? "MISSING" : "absent ";
      console.log(row(c.name, `${mark}  ${c.detail}`));
      if (!c.ok && c.fix) console.log(row("", `fix: ${c.fix}`));
    }
    console.log("\nlookout itself");
    // Which logs were read, so "none active" cannot be mistaken for "nothing
    // has ever gone wrong": run somewhere lookout has no config and there is
    // simply no project log to read.
    console.log(row("  logs", sources.length ? sources.join(", ") : "none here (no configured project, no checkout)"));
    if (groups.length === 0) {
      console.log(row("  incidents", "none active in the last 30 days"));
    } else {
      console.log(row("  incidents", `${groups.length} active group(s), ${hot.length} recurring`));
      if (self.top) {
        console.log(
          row(
            "  heaviest",
            `[${self.top.kind}] ${self.top.count}x ${self.top.message.slice(0, 70)}` +
              (self.top.recurred ? " (healed before; came back)" : ""),
          ),
        );
      }
      if (hot.length > 0) {
        console.log(row("", "worth a `lookout self-heal` (manual; it edits lookout's own source)"));
      }
    }
    console.log(
      requiredFailing.length === 0
        ? "\nAll required checks passed."
        : `\n${requiredFailing.length} required check(s) failing.`,
    );
  }

  return requiredFailing.length === 0 ? 0 : 1;
}
