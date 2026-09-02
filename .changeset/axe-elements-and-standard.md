---
"@nannier-com/lookout": patch
---

**An accessibility finding names the elements, the standard and each check.**
axe reports far more than a rule id, and lookout kept the selectors of three
elements and a flattened summary. The capture now keeps, for up to twenty
failing elements, a summary of the element's markup (its tag, a few naming
attributes such as `id`, `aria-label` and `alt`, an `href` stripped of its
query, and the visible text, at most eighty characters; values, sources,
styles, handlers and other data attributes are dropped before anything is
written, because the record is committed with the project), the impact axe
gave the element, and the sentence each of axe's checks wrote about it, plus
the rule's tags.

The ticket's prose spends them: "It fired on 2 elements on this screen: the
`<h4>` reading "Overview", the `<h5 id="recent">` reading "Recent activity""
instead of a selector list (the selectors stay in the record for the agent
that resolves them), "It is a WCAG 2.0 level A requirement" or "an axe
best-practice rule rather than a WCAG requirement" from the tags, and one
sentence per check per element in place of the flattened summary. A capture
from before these were kept reads as before. The issue document also merges
what the finding kept of its view with what the workspace still records of
the shot, field by field, instead of letting one shadow the other whole.
