---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): lookout captures a control's keyboard-focus and pointer-hover states deliberately and judges their indicators, with `navigation.maxFocusStatesPerRoute` and `navigation.maxHoverStatesPerRoute` as the new options.

**Where the keyboard and the pointer are.** The navigation planner gains two outcomes. `focus` presses Tab to put Chromium into keyboard modality, focuses the one control it named, and verifies the browser really is showing it as keyboard focus; a control that will not show one is skipped rather than photographed, because that shot would file lookout's own capture as the application's defect. `hover` rests the pointer on a control, waits for anything on a JS delay, and is skipped at phone width where there is no pointer. One of each per route by default, counted separately from `maxStatesPerRoute` so a route spending its budget on overlays can still have them. Their shots are named `focus-<control>` and `hover-<control>`.

**This narrows a rule the rubric was right to have.** Focus rings were never filed because nothing in a rest, overlay or in-page shot holds focus on purpose, so a ring there is an accident of what was clicked last. That still holds everywhere except a shot whose manifest line says lookout put the keyboard on a named control, where that one control's indicator becomes judgeable. Focus ORDER remains never-file: a still shows which control has focus, never how it got there.

**The half a judge cannot see is measured.** A screenshot never draws the cursor and a judge sees a state's view group without its rest sibling, so "hovering did nothing" is a comparison, not something visible in the evidence. lookout compares each indicator shot with its own rest shot and files `focus-invisible` (`a11y`) or `hover-silent` (`states`) when they are identical, one-sided on purpose: identical pixels prove the interaction did nothing, different pixels prove only that something moved.

`judge-core` rises to version 11 because the shared rubric changed, so every panel's standing verdicts are re-judged once, in every project. `plan-navigation` rises to version 4, and a cached plan made by an older planner is now re-planned even when the route's controls have not moved, since otherwise no existing project would ever receive one of these states.

Not graded against the frozen regression set: the family replay that would have measured whether the narrowed rubric costs any settled claim was stopped before it finished. The four gates are green and the behaviour was verified against a served fixture, but the judging-policy half of this change ships on that evidence alone.
