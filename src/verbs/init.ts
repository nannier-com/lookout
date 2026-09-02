/**
 * `lookout init`: write `lookout.config.ts` at this project's root, and keep
 * lookout's working state out of git.
 *
 * The config sits at the root, next to package.json, and is meant to be
 * committed: it is what the team agrees lookout looks at. Everything else
 * lookout writes about the project (the backlog, the issue folders, the
 * learned skill layers, the capture workspace with its screenshots) stays
 * under `.lookout/`, which `ensureIgnored` adds to `.gitignore`. The cost is
 * stated rather than hidden: that state is per-checkout, so it does not follow
 * the repo to another machine, and deleting the directory re-rolls every issue
 * id.
 *
 * A project still holding the old `.lookout/config.ts` is migrated here rather
 * than told to move it by hand.
 */
import { nearestProjectRoot } from "../config-locate.js";
import {
  createConfig,
  ensureIgnored,
  existingConfigIn,
  legacyConfigIn,
  migrateLegacyConfig,
} from "../config-write.js";
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

  await ensureIgnored(root);
  console.log("next: check the target url/routes, then run `lookout targets` to verify");
  return 0;
}
