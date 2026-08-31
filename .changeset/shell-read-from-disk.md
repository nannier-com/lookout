---
"@nannier-com/lookout": patch
---

The page's shell is read from disk per request instead of being held in memory
from startup.

Every other page asset was already served this way, with `no-store`, so that a
rebuild during a fix session reaches an open tab on a reload. The shell was the
one part that was not: it was a template literal compiled into the server, so a
long-running `lookout ui` kept asking for whatever stylesheet names it had
loaded with. Renaming one left the running server requesting a file the rebuild
had deleted, and the page came back completely unstyled while the checkout, the
build, the type check, the linter and the tests were all correct and green.

The markup now lives in `src/ui/client/shell.html`, beside the stylesheets and
copied into `dist` with them, and `page.ts` reads it on the way out. A missing
shell answers with the name of the file it could not find rather than a blank
screen, the same way a missing stylesheet already did.
