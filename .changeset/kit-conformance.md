---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): a conformance pass that reads
whether an application is actually built out of the component kit it has, plus
the flags that drive it: `lookout design-system --audit`, and `--no-conformance`
/ `--max-conformance N` on `lookout check`.

Having a kit and using it are different facts. The scan that filed hand-rolled
duplicates until now matched names and only looked at files importing the kit
nowhere, so it never saw the common case: a screen that imports the kit for its
text and then builds a button out of a styled `div` in the same file.

The new `kit-conformance` skill reads those files with the kit's real export
list in hand, adds what the scan cannot see and refutes what it got wrong.
Nothing it says is taken on trust: a claim names a file, a symbol and a line,
the symbol is looked up in the file, and a kit component the kit does not export
is dropped rather than repeated. Verdicts are cached per file, keyed on the
file's bytes plus the skill version and the kit's exports, so a second run over
unchanged files costs nothing.

Two other things changed with it. Kits are now read rather than guessed at, so
`design-system` reports what a kit actually exports and a hand-rolled control the
kit has no equivalent for is filed as a gap in the kit instead of claiming a
duplicate of a component that was never there. And `verify-fix` rules a
skill-found finding by asking the skill again about that file, because the scan
is exactly what could not see it in the first place.
