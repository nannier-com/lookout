/**
 * Which part of the frame a defect lives in: the route's own content, or one
 * of the application's persistent chrome regions.
 *
 * A closed set, like the category vocabulary and for the same reason: a region
 * is half of a shell finding's identity, so a value invented by one judging
 * call would split the cluster the axis exists to fuse. Adding a value later
 * is safe; renaming or removing one orphans every finding filed under it, so
 * neither ever happens (see the identical note on categories in
 * src/judge/rubric.ts).
 *
 * There is deliberately no `overlay` region: an overlay is a state, and state
 * is already an axis of every fingerprint. An account menu dropped from the
 * app bar is `shell-header`; a modal raised by the page is `content`.
 *
 * This lives in backlog/ rather than judge/ because both producers need it:
 * the judge names a region in its reply, and the deterministic channel derives
 * one from axe's node selectors at capture time, and capture code must not
 * import from judge/.
 */
export const REGIONS = ["content", "shell-nav", "shell-header", "shell-footer"] as const;
export type Region = (typeof REGIONS)[number];

/** The regions whose findings are identified by component rather than route. */
export function isShellRegion(region: Region | undefined): boolean {
  return region !== undefined && region !== "content";
}

/**
 * A region as claimed by a model reply, held to the closed set.
 *
 * Unknown values come back as undefined rather than throwing, because the
 * caller's fallback is always `content`: a mangled region must never cost the
 * finding it rides on. The two failure directions are not symmetric. A defect
 * wrongly called `content` is filed per route, which is only today's noise; a
 * defect wrongly called shell merges with a genuinely different one and lets a
 * by-design ruling silence a live defect. Everything here fails toward
 * `content`.
 */
export function parseRegion(value: unknown): Region | undefined {
  return (REGIONS as readonly string[]).includes(value as string) ? (value as Region) : undefined;
}
