---
"@nannier-com/lookout": patch
---

The adversarial pass now follows the risk rather than the severity alone, and is
given the evidence its hardest cases need.

Severity says how much a defect costs if it is real. It says nothing about how
likely the judge was to be wrong, and those are different questions. Refuting
only critical and high findings therefore left the design-quality categories
unchecked, which is exactly backwards: a claim resting on a named principle
("nothing for the eye to land on first") is the judge's most valuable output and
its most easily argued into existence, while a low-severity claim about broken
copy is either in the image or it is not. `hierarchy`, `composition`, `spacing`,
`typography`, `alignment` and `consistency` are now refuted at every severity,
alongside critical and high as before.

The refuting skill was extended to ask the question that band needs: is the named
principle actually violated here, or is this a preference wearing a principle's
clothes? It refutes a finding that cannot point at a visible consequence, one
that restates the project's design language as a fault, and one resting on a
measurement, since these screenshots cannot be measured.

The refuter is also given the whole view group rather than one image. The rubric
has the judge compare a view's dark and light captures and its form-factor
progression, so a colour-scheme or responsive finding is a claim about that
comparison, and the refuter was handed the single shot the finding was filed on
and told to lean refuted when uncertain. The findings that needed the most
evidence were getting the least, and dying for want of the partner shot that
would have settled them either way.

One narrower correctness fix: a finding only counts as verified when the verifier
explicitly says `confirmed`. Any other verdict, a hedge, a word outside the
contract, or no row at all, now leaves the finding standing but unverified, which
is what actually happened. It previously counted as verified whenever any row
came back.
