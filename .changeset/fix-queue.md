---
"lookout": minor
---

A fix queue in the page: pressing play on an issue queues it, and lookout hands
one over at a time.

The play button on a card opened a Terminal there and then, so pressing it on
five cards opened five sessions into one working tree. It now writes the issue
into a queue kept at `<project>/.lookout/queue.json`, and a pump hands over the
head, waits, and moves on.

What it waits for is lookout's own ruling. A handoff opens a Terminal this
server has no handle on, so "the fix finished" is not something it can observe;
"the defect is gone" is, because `verify-fix` writes it down. The head leaves
the queue when the board says done, archived or blocked, and the next is handed
over with nothing clicked. The handoff prompt now carries the `verify-fix`
command itself rather than leaving it near the end of `Issue.md`, and the head's
row says how long it has been waiting and offers to have lookout rule on it now,
for the case where whoever was fixing it stopped without asking.

The judge's column is split to show it: the transcript on top, the queue
beneath, each row with an X that takes it back out. New routes `/api/queue`,
`/api/queue/remove` and `/api/rule`; `/api/launch` is gone, replaced by the
first of those. Starting a check is refused while an issue is being fixed,
since a check would photograph a half-edited tree.
