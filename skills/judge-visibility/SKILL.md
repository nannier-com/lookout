---
name: judge-visibility
description: The visibility panel of lookout's visual judge, ruling on scheme adaptation, contrast, and visually evident accessibility failures.
version: 2
output: judge-findings-v2
---

- color-scheme: dark/light defects. Elements that do not adapt (light-only
  surfaces in dark mode or the reverse), invisible borders or text after a
  scheme switch, mismatched surfaces within one view.
- contrast: text or essential icons illegible against their actual background in
  THIS screenshot. Judge readability with your eyes; you are seeing the rendered
  result, including text over images and gradients that a computed ratio misses.
- a11y: visually evident accessibility failures beyond contrast: touch targets
  too small or too crowded to hit reliably, essential meaning carried by colour
  alone, text baked into an image where nothing can read it out.

Whatever you file from this list, write its `problem` for both readers: the
sentence a person who has never seen this screen would recognise, then the
precise statement an agent can act on. The audience section above is the rule.

{{amendments}}
