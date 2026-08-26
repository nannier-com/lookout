---
"@nannier-com/lookout": patch
---

Say when the build is stale, and put a command in the handoff that actually runs.

Running lookout out of its own repository with a build older than the source is
invisible: the code runs, it just is not the code you wrote, and every symptom
points somewhere else. It cost real time. Every verb now checks, when there is a
`src` directory beside `dist`, whether any source file is newer than the build,
and says so plainly, including the part people forget: a server already running
holds the old code in memory until it is restarted. Published installs ship
`dist` alone, so it never fires for them.

The handoff document told whoever opened it to run `lookout verify-fix`. That
only works if `lookout` is on PATH, and in a source checkout it is not. It now
resolves the CLI it is actually running from and writes a command that works,
falling back to the bare name only when neither is usable.
