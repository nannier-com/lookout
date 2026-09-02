/**
 * What a check judged, per platform and form factor.
 *
 * A run that says "12 shots judged" has not said whether the phone shots were
 * among them. Each form factor is a rendering of its own, so the count is kept
 * per form factor: how many shots it had, how many were judged fresh or
 * served from the cache, how many carry a finding, and how many nobody could
 * vouch for. The last number is the one this exists for: a form factor the
 * judge never opened reads as "not judged" here, never as clean.
 */
import { FORM_FACTORS, PLATFORMS, type FormFactor, type PlatformKind, type ShotRecord } from "../types.js";

export interface FormFactorTally {
  platform: PlatformKind;
  formFactor: FormFactor;
  shots: number;
  judged: number;
  cached: number;
  withFindings: number;
  /** Shots some panel could not vouch for this run; judged again next run. */
  unjudged: number;
}

export function tallyFormFactors(
  shots: readonly ShotRecord[],
  judgedIds: ReadonlySet<string>,
  findingShotIds: ReadonlySet<string>,
  unjudgedIds: ReadonlySet<string>,
): FormFactorTally[] {
  const out: FormFactorTally[] = [];
  for (const platform of PLATFORMS) {
    for (const formFactor of FORM_FACTORS) {
      const here = shots.filter((s) => s.platform === platform && s.formFactor === formFactor);
      if (here.length === 0) continue;
      out.push({
        platform,
        formFactor,
        shots: here.length,
        judged: here.filter((s) => judgedIds.has(s.id)).length,
        cached: here.filter((s) => !judgedIds.has(s.id)).length,
        withFindings: here.filter((s) => findingShotIds.has(s.id)).length,
        unjudged: here.filter((s) => unjudgedIds.has(s.id)).length,
      });
    }
  }
  return out;
}

/**
 * The tally as lines a person reads: one per platform naming every form
 * factor, and one more for any form factor that was not fully judged, since
 * that is the line that changes what the reader does next.
 */
export function tallyLines(tally: readonly FormFactorTally[]): string[] {
  const lines: string[] = [];
  for (const platform of PLATFORMS) {
    const rows = tally.filter((t) => t.platform === platform);
    if (rows.length === 0) continue;
    lines.push(
      `${platform}: ` +
        rows
          .map((t) => `${t.formFactor} ${t.shots} shot(s), ${t.judged} judged, ${t.cached} cached, ${t.withFindings} with findings`)
          .join("; "),
    );
    const gaps = rows.filter((t) => t.unjudged > 0);
    if (gaps.length > 0) {
      lines.push(
        `${platform}: NOT judged: ` +
          gaps.map((t) => `${t.formFactor} ${t.unjudged} of ${t.shots}`).join(", ") +
          " (a shot nobody ruled on is not clean; judged again next run)",
      );
    }
  }
  return lines;
}
