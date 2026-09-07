---
"@nannier-com/lookout": patch
---

Validate the prepared release commit before pushing version metadata or publishing.

CI and Release now share typecheck, lint, test and build gates. Release stops if
main advances or the checked tree changes, instead of rebasing and publishing
untested code. Automatic runs, manual runs and runs with no pending changesets
all use the same gate. Major changesets are rejected using Changesets' parsed
release plan, and the release summary reports failures without claiming a publish.
