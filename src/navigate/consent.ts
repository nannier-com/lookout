/**
 * Whether navigation discovery is on for this run, and who said so.
 *
 * Two different acts can turn it on. `navigation: { enabled: true }` in a
 * project's config is that project standing behind every run it will ever
 * have. `--navigation` is one caller consenting to one run, which is what the
 * ui spends when a person flips the toggle beside the play button. Either is
 * enough on its own. `--no-navigation` beats both, because an explicit off is
 * never worth arguing with.
 *
 * This is a function rather than an expression repeated at each gate because
 * three readings of "is it on" that can disagree is how a run harvests
 * without planning, or prunes the very states it just planned: capture
 * harvests affordances and executes cached plans, `check` draws the plans up,
 * and pruning consults the plan index to know what is still intended.
 */
import type { LookoutConfig } from "../types.js";

export function navigationOn(
  config: LookoutConfig,
  flags: Record<string, string | boolean>,
): boolean {
  if (flags["no-navigation"]) return false;
  return !!config.navigation?.enabled || !!flags.navigation;
}
