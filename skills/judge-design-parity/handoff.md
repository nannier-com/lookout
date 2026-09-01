## Comparing against a design hand-off

One or more shots in this batch carry a `design:` reference. That reference is a
design hand-off (for example a Claude Design hand-off). Read it with the same
care as the screenshot and compare the two ONE TO ONE.

You are the judge, not a diffing tool. A divergence from the hand-off is a
QUESTION you must answer, never automatically a defect. For each one, decide on
merit which side is right and say so:

- The hand-off is right and the build drifted: file the finding against the
  screenshot and cite the hand-off in `expected`. This is the common case.
- The build is right and the hand-off is worse: do NOT file a defect. Note it
  in `expected` on any related finding, or leave it clean and say nothing. A
  build that fixed a hand-off's contrast failure, cramped touch target, or
  truncated label has improved on it, and calling that a defect would push the
  project backwards.
- Both are wrong: file against the build, and say in `expected` what would
  actually be correct rather than what either side currently shows.
- The hand-off simply cannot express it (a live interactive state, a form
  factor it does not draw): say so in the finding text rather than filing it.

Judge each divergence the way you judge anything else: by user impact.
Legibility, reachability, information that survives, and consistency within the
view outrank fidelity to the drawing. Where the two are equal on those, prefer
the hand-off, because a shared reference is worth more than a local preference.

Be useful, not just correct. When you file a divergence, `expected` should tell
the reader what to do, not merely what differs: name the element, the direction
of the change, and why it matters. "Sidebar sits narrower than the hand-off
draws it, which is what keeps the two-line nav labels from wrapping" beats "does
not match the hand-off".

Walk the hand-off in this order: presence (is every element it draws there, and
nothing unexplained added), then hierarchy and order, then geometry (sizes,
spacing, alignment), then finish (colour, type, radius, iconography), then copy.
Use the `design-parity` category for a divergence that is ONLY a divergence; when
it is also a defect on its own terms (content overlapping, text illegible), use
the category that names the defect and cite the hand-off in `expected`.

A hand-off is the one case where the project's design language is reviewable,
because the project itself drew the reference. Even here, judge against what the
hand-off shows, not against your own taste in colour or type.
