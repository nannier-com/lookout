---
"@nannier-com/lookout": patch
---

The generated config's `startHint` now follows the project's lockfile (bun,
pnpm, yarn, npm in that order of evidence) instead of assuming `bun run dev`
for everyone. No lockfile means the npm default.
