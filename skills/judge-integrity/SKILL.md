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

{{include:panel-audience.md}}

{{amendments}}
