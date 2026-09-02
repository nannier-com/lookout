---
"@nannier-com/lookout": patch
---

**The calls-to-action consent moves under the cog.** It was an icon button
beside play, which made a consequential decision look like a view preference:
a small outline that changed colour, with the whole of what it authorizes
living in a tooltip nobody hovers. It is a settings row now, next to where the
project and the base URL are chosen, and it says in words which of the two
runs play will spend: `Off: runs photograph each route at rest`, or
`On for this project`, with the consequence spelled out underneath rather than
hidden in a title attribute. The row is not a `<label>`, unlike the rows above
it, so a stray click on the description cannot grant the consent; only the
button does.

What it authorizes has not changed, and neither has where it is stored: the
server still remembers the directory the consent was given for, so pointing
the page at another project starts from no again.

The one thing the old placement did well was warn on the way to the button, so
play keeps that: while calls to action are on, its tooltip says the run will
click this project's own buttons and links, destructive ones included.
