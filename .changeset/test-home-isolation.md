---
"@nannier-com/lookout": patch
---

The test suite no longer records incidents into the operator's home.

`recordIncident` writes under `LOOKOUT_HOME`, which falls back to
`~/.lookout`, and the tests that exercise judge ingestion never set it. Every
run therefore appended real-looking failures to the real log: 585 of the 599
lines in one operator's `incidents.jsonl` were fixtures, carrying the project
names `proj` and `demo` from the test helpers. The learning area of `lookout ui`
reads that log to answer "what has actually gone wrong with lookout", so the
page was reporting the test suite's own manufactured failures back to the person
running it.

A `bunfig.toml` preload points `LOOKOUT_HOME` at a throwaway directory before
the first test file loads, so this holds for every test rather than for the
tests that remembered. A hook in the preload puts that home back whenever a test
clears the variable, since an unset `LOOKOUT_HOME` is the operator's real one and
a teardown that tidied up after itself used to hand the real home to everything
that ran after it.

`test/home-isolation.test.ts` keeps the guarantee honest. It fails if the home
is ever the operator's, and it fails if the run was started from a directory
where `bunfig.toml` is not found, which is the one way the preload can silently
not apply.
