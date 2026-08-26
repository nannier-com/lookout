---
"@nannier-com/lookout": patch
---

Give every finding the screenshot it was filed against.

A finding is a claim about one screenshot, and `lookout ui` showed everything
except that screenshot: a title, a category and three words of context, with the
evidence for the claim living somewhere else on the page. The finding event was
already carrying the path, route, form factor, scheme, the judge's full prose and
whether an adversarial pass had verified it, and all of it was being discarded at
render time.

Each finding is now a card with its own thumbnail, the judge's reasoning in full,
and, matched back through the dispatched cluster's screenshots, which fix session
owns the defect and what state that session is in. So a reader can go from
"dark-scheme captures render the same light surfaces" to the capture that proves
it, and on to the agent currently fixing it, without leaving the page.

Two ordering bugs fell out of building it. Findings sorted reverse
chronologically, which put a low-severity nit above three criticals on a page
whose job is triage; they now sort worst first, newest first within a severity.
And the section's repaint signature keyed on the number of findings alone, so a
re-judged finding kept showing its old prose until the count happened to change.
It now keys on what the cards actually draw.
