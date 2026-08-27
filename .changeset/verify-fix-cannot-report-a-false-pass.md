---
"@nannier-com/lookout": patch
---

`verify-fix` can no longer report a pass for work it did not verify.

The verb an orchestrating session gates on used to answer `passed`, exit 0, in
three cases where it had checked nothing. An `--issue` id lookout had never
heard of (a typo, or one carried over from another project) read as a fix
confirmed, so the session recorded a verification that never ran. An issue whose
findings were all `blocked` reported success instead of the exit 3 that exists
to stop it being dispatched again. And an issue already `fixed` or `by-design`
claimed this run had passed it.

Those four cases now answer separately. An unknown id, or an id whose findings
have gone, raises an operator error and exits 2 with a hint about where ids come
from. A blocked issue exits 3 and restates the recorded reason. An issue already
adjudicated exits 0 with the verdict `already-adjudicated`, which says what is
true: there was nothing here to verify.

Two guards that decide a verdict were also leaking.

A finding somebody ruled `by-design` under the issue's own cluster key re-fired
on every capture, because an intentional defect is still there by definition. It
was counted as the issue's own defect persisting, so the issue could never pass
however well the real defect had been fixed, and was then blocked with a reason
claiming a defect persists that somebody had already ruled intended. The merge
suppressed these; the verdict now does too.

The pixels-moved guard, which stops judge variance alone closing a real defect,
switched itself off whenever `.lookout/evidence/` had been cleaned. Its baseline
came only from the capture report living in that gitignored directory, and an
empty baseline made every fresh screenshot look changed. It now falls back to
the evidence hashes in the committed `backlog.json`, which outlive the pixels,
and a shot with no baseline from either source is no longer counted as changed.
Where nothing in scope can be compared at all, the re-capture acceptance
criterion is ruled `not-verifiable` rather than asserting the screenshots are
byte-identical to a run lookout never saw.
