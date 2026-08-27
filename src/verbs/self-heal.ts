/**
 * `lookout self-heal`: fix what lookout keeps getting wrong, in lookout itself.
 *
 * Everything else here judges an application. This judges the tool, from the
 * one record that outlives a run: the incident log, pooled across every project
 * on this machine.
 *
 * It is the most dangerous thing in the codebase, because it edits the code
 * that does the judging. What makes it acceptable is that nothing it writes is
 * trusted. The subprocess may read and edit inside lookout's own checkout and
 * may not run a single command, so whether the change is good is never its own
 * report: lookout runs the type check, the linter, the tests and the build
 * itself, replays a frozen set of already-adjudicated screenshots when one is
 * available, and reverts everything if any of them fails.
 *
 * It commits, and it never pushes. A local commit is one `git revert` away; a
 * push is somebody else's problem to undo.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadSkill, renderSkill } from "../skills/load.js";
import { clusterIncidents, lookoutHome, readIncidents, recordIncident } from "../skills/incidents.js";
import { extractJson, invokeClaude } from "../judge/engine.js";
import { LookoutError } from "../types.js";
import { execFileAsync, nowIso, printJson, str, type Parsed } from "../util.js";

/** What the healer may do: read and edit its own source, and nothing else. */
const ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

/** Long enough for a cold type check and a full suite on a busy machine. */
const GATE_TIMEOUT_MS = 10 * 60_000;

export interface Gate {
  name: string;
  command: string;
  ok: boolean;
  output: string;
}

/**
 * lookout's own checkout, or null when this is an installed package.
 *
 * The same test `warnIfStale` uses: a `src` directory beside `dist` means the
 * source is here. A published install has no source to heal and no repository
 * to revert in, so this refuses rather than editing node_modules.
 *
 * LOOKOUT_CHECKOUT overrides it, which is how a test points this at a fixture
 * instead of at the repository it is running from.
 */
export function ownCheckout(): string | null {
  const root = process.env.LOOKOUT_CHECKOUT ?? fileURLToPath(new URL("../..", import.meta.url));
  return existsSync(join(root, "src")) && existsSync(join(root, ".git")) ? root : null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function runGate(cwd: string, name: string, command: string, args: string[]): Promise<Gate> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: GATE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { name, command: `${command} ${args.join(" ")}`, ok: true, output: `${stdout}${stderr}`.slice(-4000) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      name,
      command: `${command} ${args.join(" ")}`,
      ok: false,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.slice(-4000),
    };
  }
}

/** Where a reverted attempt is kept, so a person can read what was tried. */
function attemptDir(stamp: string): string {
  return join(lookoutHome(), "self-heal", stamp);
}

/** How long a lock stays believable before it is treated as abandoned. */
export const LOCK_STALE_MS = 30 * 60_000;

export function lockPath(): string {
  return join(lookoutHome(), "self-heal.lock");
}

/**
 * Is another self-heal already running? Two of them in one checkout would
 * revert each other's work and commit the result.
 */
export function lockHeld(path: string, now = Date.now()): boolean {
  try {
    return now - statSync(path).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export async function selfHeal(parsed: Parsed): Promise<number> {
  const lock = lockPath();
  if (lockHeld(lock)) {
    throw new LookoutError(
      "another self-heal is already running",
      `if it died, remove ${lock}`,
    );
  }
  await mkdir(lookoutHome(), { recursive: true });
  await writeFile(lock, nowIso());
  try {
    return await heal(parsed);
  } finally {
    await rm(lock, { force: true });
  }
}

async function heal(parsed: Parsed): Promise<number> {
  const checkout = ownCheckout();
  if (!checkout) {
    throw new LookoutError(
      "self-heal needs lookout's own source checkout",
      "this is an installed package: there is no source here to fix and no repository to revert in",
    );
  }

  // A dirty tree means something else is mid-edit. Reverting on a failed gate
  // would take that with it, and committing on a passing one would sweep it in.
  const dirty = await git(checkout, ["status", "--porcelain"]);
  if (dirty) {
    throw new LookoutError(
      "lookout's checkout has uncommitted changes",
      "self-heal reverts everything it wrote when a gate fails, so it will not run over work in progress",
    );
  }

  const incidents = readIncidents();
  const groups = clusterIncidents(incidents);
  if (groups.length === 0) {
    console.log("nothing to heal: no incidents recorded.");
    return 0;
  }

  const model = str(parsed.flags.model) ?? "sonnet";
  const stamp = nowIso().replace(/[:.]/g, "-");
  const before = await git(checkout, ["rev-parse", "HEAD"]);

  const skill = await loadSkill(null, "self-heal");
  const prompt = renderSkill(skill.text, {
    checkout,
    incidents: groups
      .slice(0, 12)
      .map(
        (g, i) =>
          `${i + 1}. [${g.kind}] seen ${g.count}x: ${g.message}\n` +
          `   latest: ${g.latest.at}${g.latest.verb ? ` during \`lookout ${g.latest.verb}\`` : ""}` +
          (g.latest.detail ? `\n   detail: ${g.latest.detail.slice(0, 600)}` : ""),
      )
      .join("\n"),
  });

  console.log(`${groups.length} incident group(s) on record; healing in ${checkout}`);
  const res = await invokeClaude({
    prompt,
    cwd: checkout,
    model,
    allowedTools: ALLOWED_TOOLS,
    timeoutMs: GATE_TIMEOUT_MS,
  });

  let report: { summary?: string; cause?: string; incident?: string; changed?: boolean; files?: string[] };
  try {
    report = extractJson(res.text) as typeof report;
  } catch {
    report = { summary: res.text.slice(0, 300), changed: true };
  }

  const changed = await git(checkout, ["status", "--porcelain"]);
  if (!changed) {
    console.log(`nothing changed: ${report.summary ?? "the healer decided against it"}`);
    return 0;
  }

  // Every gate, always, and in the order that fails cheapest first.
  const gates: Gate[] = [];
  gates.push(await runGate(checkout, "typecheck", "bun", ["run", "typecheck"]));
  if (gates.at(-1)!.ok) gates.push(await runGate(checkout, "lint", "bun", ["run", "lint"]));
  if (gates.at(-1)!.ok) gates.push(await runGate(checkout, "test", "bun", ["test"]));
  if (gates.at(-1)!.ok) gates.push(await runGate(checkout, "build", "bun", ["run", "build"]));

  // The judge itself, graded against verdicts that were settled before any of
  // this ran. Only possible when a project is named, because the frozen set
  // belongs to a project rather than to lookout.
  const projectDir = str(parsed.flags.project);
  if (projectDir && gates.at(-1)!.ok) {
    gates.push(
      await runGate(projectDir, "regression replay", "bun", [join(checkout, "dist", "cli.js"), "skills", "replay"]),
    );
  }

  const failed = gates.filter((g) => !g.ok);
  for (const g of gates) console.log(`  ${g.ok ? "pass" : "FAIL"}  ${g.name}`);

  if (failed.length > 0) {
    const dir = attemptDir(stamp);
    await mkdir(dir, { recursive: true });
    const diff = await git(checkout, ["diff"]);
    await writeFile(join(dir, "attempt.diff"), diff);
    await writeFile(
      join(dir, "gates.txt"),
      gates.map((g) => `=== ${g.name} (${g.ok ? "pass" : "FAIL"}): ${g.command}\n${g.output}`).join("\n\n"),
    );
    await writeFile(join(dir, "report.json"), JSON.stringify({ ...report, raw: res.text }, null, 2));

    await git(checkout, ["checkout", "--", "."]);
    await git(checkout, ["clean", "-fd"]);
    recordIncident({
      at: nowIso(),
      kind: "self-heal-rollback",
      verb: "self-heal",
      message: `self-heal reverted: ${failed.map((g) => g.name).join(", ")} failed`,
      detail: report.summary,
      project: checkout,
    });
    console.log(`\nreverted. ${failed.length} gate(s) failed; the attempt is kept at ${dir}`);
    return 1;
  }

  // A patch, always. A fix to lookout's own behaviour is not a new capability,
  // and neither lookout nor its pipeline is allowed to spend a minor on one.
  const slug = (report.incident ?? report.summary ?? "self-heal")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  await writeFile(
    join(checkout, ".changeset", `self-heal-${slug || stamp}.md`),
    `---\n"@nannier-com/lookout": patch\n---\n\n${report.summary ?? "Fixed a failure lookout kept hitting."}\n\n` +
      `${report.cause ?? ""}\n\nFound by \`lookout self-heal\` in the incident log, and kept only because the type ` +
      `check, the linter, the tests${projectDir ? ", the build and a replay of the frozen regression set" : " and the build"} all passed after it.\n`,
  );

  await git(checkout, ["add", "-A"]);
  await git(checkout, [
    "commit",
    "-m",
    `fix: ${report.summary ?? "heal a recurring failure"}\n\n${report.cause ?? ""}\n\n` +
      `Found by \`lookout self-heal\` reading the incident log. Every gate passed before this was kept: ` +
      `${gates.map((g) => g.name).join(", ")}. Not pushed: that is a person's call.`,
  ]);
  const after = await git(checkout, ["rev-parse", "--short", "HEAD"]);

  const payload = {
    healed: true,
    incident: report.incident ?? null,
    summary: report.summary ?? null,
    cause: report.cause ?? null,
    files: report.files ?? [],
    gates: gates.map((g) => ({ name: g.name, ok: g.ok })),
    commit: after,
    previous: before.slice(0, 7),
    costUsd: res.costUsd ?? 0,
  };
  if (parsed.flags.json) {
    printJson(payload);
  } else {
    console.log(`\nhealed and committed ${after}: ${report.summary ?? ""}`);
    if (report.cause) console.log(`  cause: ${report.cause}`);
    console.log(`  not pushed. \`git revert ${after}\` undoes it.`);
  }
  return 0;
}

