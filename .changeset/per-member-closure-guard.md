---
"@nannier-com/lookout": patch
---

verify-fix closes an AI finding only when that finding's own pixels moved.
The pixels-moved guard was scope-wide, so a multi-route issue could pass
when one route was edited while the other's unchanged views were served
from the judge cache, closing the untouched member on silence. Closure is
now vouched for per member, at zero model cost, and the verdict note names
the routes whose findings sat on unmoved pixels. The deliberate cost: a
member fixed by an earlier unrelated commit blocks at the attempt cap and
needs a person.
