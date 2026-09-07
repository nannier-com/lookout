/**
 * `lookout self-heal`: fix what lookout keeps getting wrong, in lookout itself.
 *
 * Everything else here judges an application. This judges the tool, from the
 * one record that outlives a run: the incident log, read from this checkout
 * and from the project the run was started in.
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
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSkill, renderSkill } from "../skills/load.js";
import { incidentSources, readIncidentsFrom, recordIncident, shapeOf } from "../skills/incidents.js";
import {
  attemptDir,
  ownCheckout,
  selfHealDir,
  selfHealLockPath,
} from "../checkout.js";
import { LOOKOUT_DIR, locateConfig } from "../config-locate.js";
import {
  activeGroups,
  compactIncidents,
  discoverReplayProjects,
  pickGroup,
  readHeals,
  recordHeal,
  type ActiveGroup,
} from "../skills/heal-select.js";
import { DEFAULT_JUDGE_MODEL, extractJson, invokeClaude } from "../judge/engine.js";
import type { Capability } from "../judge/ai-types.js";
import { LookoutError } from "../types.js";
import { execFileAsync, lockHeld, LOCK_STALE_MS, nowIso, printJson, str, type Parsed } from "../util.js";
import { withExternalStateLock } from "../state/lock.js";

/**
 * What the healer may do: read, search and edit its own source, and nothing
 * else. Capabilities rather than one CLI's tool names, because which words
 * spell them is the adapter's business; a shell is withheld either way, since
 * lookout runs the gates itself rather than trusting the reply.
 */
const CAPABILITIES: Capability[] = ["read-files", "search-files", "edit-files"];

/** Long enough for a cold type check and a full suite on a busy machine. */
const GATE_TIMEOUT_MS = 10 * 60_000;

export interface Gate {
  name: string;
  command: string;
  ok: boolean;
  output: string;
}

// Re-exported: this is where self-heal's callers and its tests look for it,
// and it lives in `checkout.ts` because the incident log needs it too, and
// `skills/ -> verbs/` would be an inverted import.
export { ownCheckout };

/**
 * The logs one heal may read: lookout's own checkout, the project the run was
 * started in, and the one `--project` names. Order is provenance, not
 * priority; `readIncidentsFrom` sorts the entries by time.
 */
function healSources(parsed: Parsed): string[] {
  return incidentSources(
    ownCheckout(),
    locateConfig(process.cwd())?.projectDir,
    str(parsed.flags.project),
  );
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

/**
 * Refuse unless the checkout ignores `.lookout/`.
 *
 * Not a nicety: a failed gate runs `git clean -fd`, which would delete the
 * attempt this verb had just written and the log it read to choose the work.
 * lookout's own repository has ignored it since before its state moved here;
 * a checkout that does not is told rather than quietly damaged.
 */
async function requireIgnoredState(checkout: string): Promise<void> {
  try {
    // The trailing slash matters: `.lookout/` is a directory-only pattern, and
    // git answers "not ignored" for a bare `.lookout` that does not exist yet,
    // which is every checkout's first heal.
    await execFileAsync("git", ["check-ignore", "-q", `${LOOKOUT_DIR}/`], { cwd: checkout });
  } catch {
    throw new LookoutError(
      `${checkout} does not ignore ${LOOKOUT_DIR}/`,
      `self-heal keeps its lock, its heals and its reverted attempts there, and reverts with \`git clean\`; add ${LOOKOUT_DIR}/ to .gitignore first`,
    );
  }
}

/**
 * Whether another self-heal is already running, and how long its claim stands.
 *
 * Two of them in one checkout would revert each other's work and commit the
 * result. The mechanism is shared with `skills improve`, which guards its own
 * writes the same way, so it lives in util and is re-exported here: this is
 * where it was first needed and where its callers look for it.
 */
export { LOCK_STALE_MS, lockHeld };

export async function selfHeal(parsed: Parsed): Promise<number> {
  // Resolved first, because the lock, the heals and the attempts all live
  // inside it now. An installed package has no source to fix and no
  // repository to revert in, so it never gets as far as taking a lock.
  const checkout = ownCheckout();
  if (!checkout) {
    throw new LookoutError(
      "self-heal needs lookout's own source checkout",
      "this is an installed package: there is no source here to fix and no repository to revert in",
    );
  }
  // The tree is judged by `git status` twice in this verb, and lookout's own
  // state is in the tree now. A checkout that does not ignore `.lookout/`
  // would look permanently dirty to the first check and have its records
  // deleted by the `git clean` of the second.
  await requireIgnoredState(checkout);

  const lock = selfHealLockPath(checkout);
  await mkdir(selfHealDir(checkout), { recursive: true });
  return withExternalStateLock(lock, "lookout self-heal", async () => {
    // The one writer allowed to rewrite the append-only logs: old entries
    // leave once a file is big enough to matter. Once per source, because
    // each project keeps its own and each grows at its own rate.
    for (const dir of healSources(parsed)) {
      const compacted = compactIncidents(dir);
      if (compacted > 0) console.log(`${dir}: compacted ${compacted} incident(s) older than 90 days`);
    }
    return heal(parsed, checkout);
  });
}

/** The one group, with enough of its occurrences to see the pattern. */
function describeGroup(g: ActiveGroup, incidents: Parameters<typeof activeGroups>[0]): string {
  const occurrences = incidents
    .filter((i) => i.kind === g.kind && shapeOf(i.message) === g.message)
    .slice(-5);
  return [
    `1. [${g.kind}] seen ${g.count}x in the window: ${g.message}` +
      (g.recurred ? "  (healed before; it came back)" : ""),
    ...occurrences.map(
      (i) =>
        `   - ${i.at}${i.verb ? ` during \`lookout ${i.verb}\`` : ""}` +
        (i.detail ? `: ${i.detail.slice(0, 400)}` : ""),
    ),
  ].join("\n");
}

async function heal(parsed: Parsed, checkout: string): Promise<number> {
  // A dirty tree means something else is mid-edit. Reverting on a failed gate
  // would take that with it, and committing on a passing one would sweep it in.
  const dirty = await git(checkout, ["status", "--porcelain"]);
  if (dirty) {
    throw new LookoutError(
      "lookout's checkout has uncommitted changes",
      "self-heal reverts everything it wrote when a gate fails, so it will not run over work in progress",
    );
  }

  // Every log this run is entitled to read: lookout's own checkout, which
  // holds the failures that happened with no project in scope, the project the
  // run was started in, and the one `--project` names. Pooling across every
  // project on the machine is what the home used to buy and what this gives
  // up: a heal now answers what broke where lookout was actually working.
  const sources = healSources(parsed);
  const incidents = readIncidentsFrom(sources);
  const groups = activeGroups(incidents, readHeals(checkout));
  if (groups.length === 0) {
    console.log("nothing to heal: no active incidents in the window.");
    return 0;
  }

  // lookout picks the group, not the model. One group per run was a sentence
  // in the prompt before; a rule only the prompt enforces is not a rule, and
  // the deterministic pick is also what makes the healed-marker mechanical.
  const { picked, skipped } = pickGroup(groups);
  for (const s of skipped) {
    console.log(`  skipping [${s.group.kind}] ${s.group.message.slice(0, 80)}: ${s.why}`);
  }
  if (!picked) {
    console.log("nothing this run can heal: every active group needs a person.");
    return 0;
  }

  const model = str(parsed.flags.model) ?? DEFAULT_JUDGE_MODEL;
  const stamp = nowIso().replace(/[:.]/g, "-");
  const before = await git(checkout, ["rev-parse", "HEAD"]);

  const skill = await loadSkill(null, "self-heal");
  const prompt = renderSkill(skill.text, {
    checkout,
    incidents: describeGroup(picked, incidents),
  });

  console.log(
    `${groups.length} active group(s); healing the heaviest` +
      (picked.recurred ? " (healed before, and it came back)" : "") +
      ` in ${checkout}`,
  );
  const res = await invokeClaude({
    prompt,
    cwd: checkout,
    model,
    capabilities: CAPABILITIES,
    timeoutMs: GATE_TIMEOUT_MS,
  });

  let report: { summary?: string; cause?: string; incident?: string; changed?: boolean; files?: string[] };
  try {
    report = extractJson(res.text) as typeof report;
  } catch {
    // The report is load-bearing here: the changeset text, the commit
    // message and the healed-marker all derive from it, and this is the
    // most dangerous subprocess in the codebase. An editor that cannot
    // follow the reply contract does not get its edits committed under
    // fabricated provenance; the attempt is kept for a person, the tree is
    // reverted, and the failure is an incident like any other.
    const dir = attemptDir(checkout, stamp);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "attempt.diff"), await git(checkout, ["diff"]));
    await writeFile(join(dir, "raw-reply.txt"), res.text);
    await git(checkout, ["checkout", "--", "."]);
    await git(checkout, ["clean", "-fd"]);
    recordIncident({
      at: nowIso(),
      kind: "healer-unparseable",
      verb: "self-heal",
      message: "healer reply was not parseable JSON; the attempt was reverted",
      detail: res.text.slice(0, 600),
      project: checkout,
    });
    console.log(`reverted: the healer's reply was not the contract. The attempt is kept at ${dir}`);
    return 1;
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

  // The judge itself, graded against verdicts that were settled before any
  // of this ran. --project names the frozen set to replay; without it,
  // lookout finds up to two recent projects that hold one, because a gate
  // the protocol calls part of the bar should not be an opt-in flag. When
  // none exists anywhere, the commit says so instead of implying it ran.
  const named = str(parsed.flags.project);
  if (named && !existsSync(named)) {
    throw new LookoutError(`--project ${named} does not exist`, "a bad path would fail the gate and revert a possibly good heal");
  }
  const replayDirs = gates.at(-1)!.ok
    ? named
      ? [named]
      : await discoverReplayProjects(incidents)
    : [];
  for (const dir of replayDirs) {
    if (!gates.at(-1)!.ok) break;
    gates.push(
      await runGate(dir, `regression replay (${dir})`, "bun", [join(checkout, "dist", "cli.js"), "skills", "replay"]),
    );
  }
  const replayRan = gates.some((g) => g.name.startsWith("regression replay"));

  const failed = gates.filter((g) => !g.ok);
  for (const g of gates) console.log(`  ${g.ok ? "pass" : "FAIL"}  ${g.name}`);

  if (failed.length > 0) {
    const dir = attemptDir(checkout, stamp);
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
      // The target group's shape rides along so repeated failures on one
      // group are countable, which is what "needs a person" is made of.
      detail: `target: ${picked.message} | ${report.summary ?? ""}`,
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
  // The directory has to exist before the write: a checkout without it threw
  // AFTER every gate passed, leaving the healed tree dirty, which then
  // tripped the clean-tree precondition on the next run.
  await mkdir(join(checkout, ".changeset"), { recursive: true });
  await writeFile(
    join(checkout, ".changeset", `self-heal-${slug || stamp}.md`),
    `---\n"@nannier-com/lookout": patch\n---\n\n${report.summary ?? "Fixed a failure lookout kept hitting."}\n\n` +
      `${report.cause ?? ""}\n\nFound by \`lookout self-heal\` in the incident log, and kept only because the type ` +
      `check, the linter, the tests${replayRan ? ", the build and a replay of the frozen regression set" : " and the build"} all passed after it.` +
      `${replayRan ? "" : " No project with a usable frozen set was found, so the judge itself was not replayed."}\n`,
  );

  await git(checkout, ["add", "-A"]);
  await git(checkout, [
    "commit",
    "-m",
    `fix: ${report.summary ?? "heal a recurring failure"}\n\n${report.cause ?? ""}\n\n` +
      `Found by \`lookout self-heal\` reading the incident log. Every gate passed before this was kept: ` +
      `${gates.map((g) => g.name).join(", ")}.` +
      `${replayRan ? "" : " The frozen-set replay did not run: no project holding one was found."}` +
      ` Not pushed: that is a person's call.`,
  ]);
  const after = await git(checkout, ["rev-parse", "--short", "HEAD"]);
  recordHeal(checkout, { at: nowIso(), kind: picked.kind, shape: picked.message, commit: after });

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
