---
"@nannier-com/lookout": patch
---

**Capture records how each view was photographed, and the checks keep what a
fixer needs.** Every web shot now carries the URL it loaded (with the scheme
in it) and where it landed when that differs, the viewport in CSS pixels and
the device scale, how the colour scheme was applied, the element when one was
framed, and for a state other than rest the planner's description of it and
the control that was clicked to reach it, with what was expected. The issue
document prints these ahead of anything it would reconstruct from the config,
and the finding keeps a copy, so a cleaned workspace loses none of it.

A thrown page error keeps its stack (twelve frames), which names the file
and line that threw; a console error keeps its column and how many times it
fired, counted on the first sighting instead of filed again; a failed request
keeps its method and resource type; the horizontal-overflow checks keep the
five worst protruders with their paths, not only the worst; a dead control
keeps its selector and role and the path it was expected to lead to, and the
provenance join now names its element too.
