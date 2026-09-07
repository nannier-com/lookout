---
"@nannier-com/lookout": patch
---

The settings panel can be dismissed with Escape, and the cog says so.

The cog was the only control that opened the panel and the only one that closed
it, while still reading "Settings" with the panel open, so the way out was a
button that did not look like one. Escape, which is what people try first, fell
straight past the panel to the filter underneath it and cleared that instead.

Escape now closes the panel, taking its turn after the confirm prompt and the
shot inspector and before the filter, for the same reason those two come first:
dismissing what somebody is looking at must not quietly clear something else.
While the panel is open the cog reads "Close settings", and its tooltip names
the key.
