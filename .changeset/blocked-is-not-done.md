---
"@nannier-com/lookout": minor
---

Stop filing blocked work under a green "settled" heading, and keep done and
archived work reachable.

"Settled" counted `passed` and `blocked` together and coloured the total green.
Blocked does not mean settled: `verify-fix` rules a cluster blocked when it has
exhausted its attempts and lookout stops dispatching it, so the defect is still
there and now needs a person. On a real project that put ten unfixed defects
under a green success number. Blocked is now its own count, coloured as the
problem it is, and its tile says what it means.

The board also carries the two states it used to drop entirely. A finding marked
`fixed` reads as **done**, one marked `by-design` reads as **archived**, and both
have their own tile. Unfiltered, the page shows what still needs doing; clicking
done or archived brings the settled work back into view. Cluster status follows
the same precedence: anything still open is live work, then blocked, then done,
then archived.

The severity numbers count outstanding work only, so a critical somebody already
fixed stops inflating "critical". They are filter controls now, and a filter is
only useful if its number means what it says.

A clear control sits at the end of the tile row whenever a filter is on, next to
the tiles that set it, alongside the existing one in the filter bar and the
Escape key.
