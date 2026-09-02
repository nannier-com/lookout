---
"@nannier-com/lookout": patch
---

**The issue document names the other issues filed on the same screenshot.** A
thrown error, a failed request or a blank capture on the same picture is often
the cause of the visual defect filed beside it, and clustering gives each its
own number, so the two documents never mentioned each other. An "Also on this
screenshot" section lists every open or blocked finding in another issue that
shares a screenshot with this one, by issue id, severity, rule and title, and
says that none of them is closed by fixing this one. The materializer hands
the backlog it already holds to the renderer for this; a caller rendering one
issue in isolation gets no section rather than a wrong one.
