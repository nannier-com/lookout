---
"@nannier-com/lookout": patch
---

Fixes a broken client script in `lookout ui`, and adds the test that would have
caught it.

The page's JavaScript lives inside a template literal, which means neither
`tsc` nor `eslint` ever sees it. A `\n` written in that region is consumed by
the template literal itself and emitted as a real line break inside a quoted
string in the served script, so the browser threw on load and the entire page
rendered blank while every build gate stayed green. That is exactly what
happened, and it is why the page looked empty rather than merely unhelpful.

The escape is fixed, and `test/ui-page.test.ts` now compiles every script block
in the page with `Function()`, the same parse the browser does on load and the
one thing the build never did. Verified by reintroducing the bug and watching
the test fail.
