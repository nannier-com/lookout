/**
 * `lookout init`: write `lookout.config.ts` at this project's root, and keep
 * lookout's working state out of git.
 *
 * The config sits at the root, next to package.json, and is meant to be
 * committed: it is what the team agrees lookout looks at. Everything lookout
 * produces (evidence, the backlog, the issue folders, the learned skill
 * layers) stays under `.lookout/`, which init adds to `.gitignore`. The cost
 * is stated rather than hidden: that state is per-checkout, so it does not
 * follow the repo to another machine, and deleting the directory re-rolls
 * every issue id.
 *
 * A project still holding the old `.lookout/config.ts` is migrated here rather
 * than told to move it by hand.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOOKOUT_DIR, nearestProjectRoot } from "../config-locate.js";
import { createConfig, existingConfigIn, legacyConfigIn, migrateLegacyConfig } from "../config-write.js";
import { LookoutError } from "../types.js";
import { str, type Parsed } from "../util.js";

export async function init(parsed: Parsed): Promise<number> {
  const cwd = process.cwd();
  const root = nearestProjectRoot(cwd) ?? cwd;

  const legacy = legacyConfigIn(root);
  const existing = existingConfigIn(root);

  if (existing && legacy && existing !== legacy) {
    throw new LookoutError(
      `${root} has both ${existing} and ${legacy}`,
      "the root config is the one lookout reads; delete the one under .lookout/",
    );
  }

  if (legacy) {
    const moved = await migrateLegacyConfig(legacy);
    console.log(`moved ${moved.from} to ${moved.to}`);
    for (const r of moved.rewritten) console.log(`  repointed ${r}`);
    for (const u of moved.unresolved) {
      console.log(`  ${u} is resolved relative to the config file and now points somewhere else; fix it by hand`);
    }
  } else if (existing) {
    throw new LookoutError(`${existing} already exists`, "edit it in place; init never overwrites");
  } else {
    const url = str(parsed.flags.url);
    const path = await createConfig(root, { url });
    console.log(`wrote ${path}`);
  }

  await ignoreWorkingState(root);
  console.log("next: check the target url/routes, then run `lookout targets` to verify");
  return 0;
}

/**
 * Add `.lookout/` to the project's `.gitignore`, once.
 *
 * The config is deliberately not covered by this: it lives at the root now,
 * outside the ignored directory, so a team shares it the way they share every
 * other tool's config.
 */
async function ignoreWorkingState(root: string): Promise<void> {
  const gitignore = join(root, ".gitignore");
  const ignoreLine = `${LOOKOUT_DIR}/`;
  if (!existsSync(gitignore)) {
    console.log(`note: no .gitignore here; remember to ignore ${ignoreLine}`);
    return;
  }
  const current = await readFile(gitignore, "utf8");
  if (current.split("\n").some((l) => l.trim() === ignoreLine)) return;
  const sep = current.endsWith("\n") ? "" : "\n";
  await appendFile(
    gitignore,
    `${sep}\n# lookout working state (evidence, backlog, issue folders; per-checkout).\n` +
      `# lookout.config.ts is not here on purpose: it is the project's to commit.\n${ignoreLine}\n`,
  );
  console.log(`added ${ignoreLine} to .gitignore`);
}
