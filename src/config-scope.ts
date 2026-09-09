/**
 * What a project's config still covers, as a predicate.
 *
 * Two records outlive the config that produced them. The capture report
 * accumulates shots across runs, and the backlog accumulates findings; a route
 * or a state deleted from `lookout.config.ts` leaves both behind. Judging those
 * shots forever is one bug (`check` fixed it), and settling regression claims
 * from those findings is the same bug wearing different clothes: a claim about
 * a screen nobody can reach spends one of the frozen set's twenty slots and can
 * never be retired, because no later run looks at that route to re-adjudicate
 * it.
 *
 * `shotInConfig` in ../targets.ts is the decision itself. This is the half that
 * has to read disk (navigation discovery's planned states are a file, and so
 * is the screen map), and it lives in one place so the callers cannot drift
 * into two different ideas of what "configured" means.
 */
import { resolveTargets, shotInConfig } from "./targets.js";
import { plannedStateIndex } from "./navigate/store.js";
import { mappedIndex } from "./map/scope.js";
import type { ResolvedConfig } from "./types.js";

/** The axes the scope decision is made on; a shot and a finding both carry them. */
export interface ScopedAxes {
  platform: string;
  target: string;
  route: string;
  state: string;
}

export type ScopeCheck = (axes: ScopedAxes) => boolean;

/**
 * The predicate for this config as it stands right now. Non-web records always
 * pass: native target resolution is a different shape, and a predicate that
 * never prunes a native record beats one that guesses.
 */
export async function configuredScope(resolved: ResolvedConfig): Promise<ScopeCheck> {
  const targets = resolveTargets(resolved.config, undefined, undefined, resolved.configPath);
  const planned = resolved.config.navigation?.enabled
    ? await plannedStateIndex(resolved)
    : undefined;
  const mapped = await mappedIndex(resolved);
  return (axes) => shotInConfig(axes, targets, planned, mapped);
}
