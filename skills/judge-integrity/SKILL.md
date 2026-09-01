---
name: judge-integrity
description: The integrity panel of lookout's visual judge, ruling on render failures, broken interactive states, and controls missing expected parts.
version: 2
output: judge-findings-v2
---

- render-failure: error text, blank regions, missing images, unstyled fallback
  content, raw template strings or placeholder data leaking through.
- states: a captured interactive state rendered wrongly: a stuck loading state,
  an open overlay misplaced or unstyled, a disabled control indistinguishable
  from an enabled one.
- anatomy: a familiar control missing an expected part: a dialog without a
  dismiss affordance, a form field whose label is detached or absent, a table
  header misaligned with its columns, a control that gives no sign it can be
  pressed.

Whatever you file from this list, write its `problem` for both readers: the
sentence a person who has never seen this screen would recognise, then the
precise statement an agent can act on. The audience section above is the rule.

{{amendments}}
