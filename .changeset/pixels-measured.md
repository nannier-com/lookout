---
"@nannier-com/lookout": patch
---

**How much two screenshots differ is now a measurement rather than a boolean.** `src/verify/pixels.ts` compares two PNGs channel by channel with no tolerance, reporting how many pixels changed, the smallest region containing them, how densely that region is filled, and whether the images are even the same size; a re-layout that changes the page height counts as change rather than refusing to answer, and an image that will not decode returns nothing rather than throwing. `changeSaid` puts the result in a sentence ("0.3% of pixels changed, in one 420x80 area near the top"), and `writeDiffCrop` saves the changed region enlarged. `tools/ui-check` now uses it in place of its own copy, which is where the algorithm came from and where it has caught three bugs no other gate saw. No verb behaves differently yet.
