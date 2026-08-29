---
"@nannier-com/lookout": patch
---

Harden the conformance pass after its first end-to-end run: `--max-conformance
0` now reads nothing rather than everything, a claimed symbol that is not an
identifier is rejected instead of matching the first declaration in the file,
batches run two at a time rather than strictly in series, and the reader's
account of a component is punctuated as sentences because it lands in the issue
somebody reads.
