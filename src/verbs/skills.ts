/**
 * `lookout skills <sub>`: what lookout knows how to judge, and how it learns.
 *
 *   list     the skills, their versions, and which ones this project amends
 *   diff     what this project has added to a skill
 *   freeze   rebuild the frozen regression set from the settled backlog
 *   replay   judge the frozen set with the skills as they stand
 *   improve  read this project's signals, amend a skill, and keep the amendment
 *            only if the frozen set still holds
 *
 * The verb dispatches; the work lives beside the skills themselves.
 * `skills/history` is lookout's record of what it did to its own instructions
 * and the lock it holds while doing it, `skills/replay` is the gate, and
 * `skills/amend` is the only thing here that writes.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { loadBacklog } from "./backlog.js";
import { loadSkill, projectSkillPath } from "../skills/load.js";
import { improveSkills } from "../skills/amend.js";
import { SKILL_NAMES } from "../skills/history.js";
import { replayRegression } from "../skills/replay.js";
import {
  freezeRegressionSet,
  loadRegressionSet,
  regressionDir,
} from "../skills/regression.js";
import { LookoutError } from "../types.js";
import { nowIso, printJson, str, type Parsed } from "../util.js";
import { DEFAULT_JUDGE_MODEL } from "../judge/engine.js";

// The names other modules have always imported from the verb.
export { SKILL_NAMES, historyPath, improveLockPath } from "../skills/history.js";
export { replayRegression } from "../skills/replay.js";

export async function skills(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0] ?? "list";
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
  });
  const model = str(parsed.flags.model) ?? DEFAULT_JUDGE_MODEL;

  if (sub === "list") {
    const list = await Promise.all(SKILL_NAMES.map((n) => loadSkill(resolved, n)));
    if (parsed.flags.json) {
      printJson(
        list.map((s) => ({
          name: s.name,
          version: s.version,
          description: s.description,
          shipped: s.path,
          amendment: s.amendmentPath,
        })),
      );
      return 0;
    }
    for (const s of list) {
      console.log(`  ${s.name.padEnd(20)} v${String(s.version).padEnd(4)} ${s.description}`);
      if (s.amendmentPath) console.log(`  ${" ".repeat(20)}      amended here: ${s.amendmentPath}`);
    }
    return 0;
  }

  if (sub === "diff") {
    const name = parsed.positionals[1];
    if (!name) throw new LookoutError("diff needs a skill name", `one of: ${SKILL_NAMES.join(", ")}`);
    const p = projectSkillPath(resolved, name);
    if (!existsSync(p)) {
      console.log(`${name}: this project has not amended it`);
      return 0;
    }
    console.log(await readFile(p, "utf8"));
    return 0;
  }

  if (sub === "freeze") {
    const backlog = await loadBacklog(resolved);
    const { set, outOfScope } = await freezeRegressionSet(resolved, backlog, nowIso());
    const claims = set.cases.reduce((n, c) => n + c.mustFile.length + c.mustNotFile.length, 0);
    console.log(
      `froze ${set.cases.length} screenshot(s) carrying ${claims} settled claim(s) ` +
        `into ${regressionDir(resolved)}`,
    );
    if (outOfScope > 0) {
      // Said out loud rather than silently dropped: these verdicts were real,
      // and the reason they no longer count is a config change the operator
      // made, not a defect.
      console.log(
        `  ${outOfScope} settled screenshot(s) left out: their routes or states are no longer ` +
          "configured, so no run can re-adjudicate them.",
      );
    }
    if (set.cases.length === 0 && outOfScope === 0) {
      console.log("  nothing settled yet: adjudicate findings (by-design, or verified) first.");
    }
    return 0;
  }

  if (sub === "replay") {
    const set = await loadRegressionSet(resolved);
    if (!set) throw new LookoutError("no frozen set", "run `lookout skills freeze` first");
    // --skill narrows the replay the way an amendment to that skill would:
    // one panel replays alone, the core or the refuter replays the family.
    const { violations, drift, costUsd } = await replayRegression(resolved, set, model, {
      amendedSkill: str(parsed.flags.skill),
    });
    if (parsed.flags.json) {
      printJson({ ok: violations.length === 0, cases: set.cases.length, violations, drift, costUsd });
    } else {
      // Drift prints either way: a claim its panel satisfied under a sibling
      // label is not a violation, but a panel that keeps doing it is the thing
      // to look at before trusting any of these verdicts.
      for (const d of drift) {
        console.log(`  [drift] ${d.shotId} ${d.panel}: ${d.category} filed as ${d.filed.join(", ")}`);
      }
      for (const v of violations) {
        console.log(`  [${v.kind}] ${v.shotId} ${v.panel} ${v.category}\n      ${v.why}`);
      }
      if (violations.length === 0) {
        console.log(`replay: clean over ${set.cases.length} frozen screenshot(s) ($${costUsd.toFixed(3)})`);
      } else {
        console.log(`\n${violations.length} violation(s). One replay is one sample: `);
        console.log("  `skills improve` reproduces and controls for these before rolling anything back.");
      }
    }
    return violations.length === 0 ? 0 : 1;
  }

  if (sub === "improve") {
    return await improveSkills(resolved, model, {
      propose: !!parsed.flags.propose,
      allSignals: !!parsed.flags["all-signals"],
    });
  }

  throw new LookoutError(
    `unknown skills subcommand "${sub}"`,
    "expected list | diff | freeze | replay | improve",
  );
}
