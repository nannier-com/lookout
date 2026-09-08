---
"@nannier-com/lookout": patch
---

An issue's pre and post fix screenshots stand in two columns.

The pairs were laid out along a horizontally scrolling strip: one pair beside
the next, each pair's two frames beside each other. A card is about 490px wide
on the default board, and two 144px tiles with their captions do not fit in
that, so the post-fix frame was clipped at the card's edge and every pair after
the first was off-screen behind a scrollbar nothing announced. The comparison
the section exists to show was the part you could not see.

The pairs now stack down the card, one view per line, with the frame from
before the fix in the left column and the one from after it in the right. A
header names the two columns once, so each tile is the picture alone and grows
with its column instead of sitting at a fixed 144px beside a caption that
repeated what the view's own label already said. The frames stop growing at
380px, the width of the thumbnail behind them, so a card with the judge's
column folded away shows bigger evidence rather than upscaled evidence.
