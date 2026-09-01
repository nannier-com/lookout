---
"@nannier-com/lookout": patch
---

**A ticket is written for the person reading it as well as the agent fixing
it.** An accessibility issue used to open with its "what is wrong" section
saying `heading-order: Heading levels should only increase by one`, then the
severity and rule, then the same sentence a second time, and nothing else.
There was no way to troubleshoot from that: it names a rule and explains
nothing, and a reader who does not already know the rule has been handed a
label instead of a defect.

Three separate things produced that, and all three are fixed.

Deterministic findings had no explanation to give. Ingestion copied the
check's own message into both the title and the problem, so the two fields
were one string and the document printed it twice. The checks now explain
themselves: `src/backlog/explain.ts` writes what a person would notice first,
then the check's own measurement, for every deterministic type. Accessibility
violations get the most of it, because they are the ones whose screenshot
usually looks fine: axe's fuller description, its own severity word said in
full, which elements on the screen it fired on, its account of what to change,
and a link to the rule. Two of those, the description and the per-element
failure summary, were being thrown away at capture time and are now kept.
`expected` and `observed`, which were empty strings for every deterministic
finding, are filled. Existing open findings pick all of this up the next time
their view is captured.

The judge was asked for one prose field aimed squarely at whoever was about to
edit code. The reply contract now says `problem` carries two parts in one
field: a plain sentence a reader who has never seen the screen can follow, then
the precise statement with the measurements and the rubric vocabulary in it,
with a worked example of both.

Every skill lookout has now carries the same rule, from one shared file rather
than fifteen copies of a paragraph. `{{include:}}` resolves against a skill's
own directory first and a new shared directory second, `skills/_shared/`, so a
rule governing every reply is written once. The six judge panels are category
vocabularies composed into `judge-core` rather than prompts of their own, so
they carry a one-line pointer and inherit the rule through the core; a test
asserts every skill has it and every composed panel prompt delivers it, so a
capability added later cannot quietly leave it out. `improve-skills` gains it
as a standing criterion, so an amendment written from a project's own signals
cannot trade the explanation away for terseness.

The ticket and the board render it as written: the two halves as two
paragraphs, a problem that is only its own title again dropped rather than
printed under the heading it repeats, and the element's path through the page
printed under the component name, which is often a provider that says nothing
about which element on screen was at fault.
