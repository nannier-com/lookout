---
name: judge-integrity
description: The integrity panel of lookout's visual judge, ruling on render failures, broken interactive states, and controls missing expected parts.
version: 4
output: judge-findings-v2
---

- render-failure: error text, blank regions, missing images, unstyled fallback
  content, raw template strings or placeholder data leaking through; on a
  device, a splash screen, a permission dialog, a development-client or bundler
  screen, or a crash overlay standing where the application should be.
- states: a captured interactive state rendered wrongly: a stuck loading state,
  an open overlay misplaced or unstyled, a menu opened at phone that renders
  partly off the screen, a disabled control indistinguishable from an enabled
  one.
- anatomy: a familiar control missing an expected part: a dialog without a
  dismiss affordance, a form field whose label is detached or absent, a table
  header misaligned with its columns, a control that gives no sign it can be
  pressed, navigation collapsed for a smaller form factor with no visible
  control to open it.

Where a shot in the manifest carries an `aria:` block, that is the page's
accessibility tree at the moment of the screenshot: each line is a role, its
accessible name and, for some controls, its state. It is evidence about what
exists, never about how anything looks. A control the tree lists is present
even where you cannot make it out: a dialog whose tree holds a `button "Close"`
has its dismiss affordance, a field whose tree pairs a `textbox` with a name
has its label, a control marked `[disabled]` beside one that is not is a state
the page does render. Do not file a missing part, a stuck state or an
unrendered control that the tree contradicts. Leave it out, or file only what
you can still see, such as the part being there and impossible to make out.
The tree never files anything on its own: something missing from it is a matter
for the accessibility checks, not for you. A block whose last line says lines
were not shown was cut for length, so what it omits proves nothing, and a shot
with no `aria:` block has no tree at all; judge that one from the pixels, as
before.

{{include:panel-audience.md}}

{{amendments}}
