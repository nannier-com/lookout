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

/**
 * The shell region an axe violation lives in, read off the selector paths of
 * the violating nodes, or undefined when the ancestry does not say.
 *
 * Deliberately conservative, because this feeds identity and there is no
 * judge on this channel to overrule it. It fires only when the reported
 * selectors are the WHOLE violation (axe keeps at most three, so more nodes
 * means these are a sample), when every path carries an unambiguous chrome
 * landmark, as an element or an explicit role, and when they all agree on
 * which. Class names are never consulted: `.navbar` is project vocabulary,
 * and matching on it would be guessing.
 */
export function regionFromSelectors(targets: string[], nodeCount: number): Region | undefined {
  if (nodeCount <= 0 || nodeCount > 3 || targets.length === 0) return undefined;
  const one = (sel: string): Region | undefined => {
    // An element token bounded by combinators, or start/end, optionally with
    // pseudo/attribute/id suffixes; never inside a class or another word.
    const el = (name: string): boolean =>
      new RegExp(`(^|[\\s>+~])${name}([\\s>+~.:#[]|$)`).test(sel);
    const picks: Region[] = [];
    if (el("nav") || sel.includes('[role="navigation"]')) picks.push("shell-nav");
    if (el("header") || sel.includes('[role="banner"]')) picks.push("shell-header");
    if (el("footer") || sel.includes('[role="contentinfo"]')) picks.push("shell-footer");
    return picks.length === 1 ? picks[0] : undefined;
  };
  const first = one(targets[0]!);
  if (first === undefined) return undefined;
  return targets.every((t) => one(t) === first) ? first : undefined;
}
