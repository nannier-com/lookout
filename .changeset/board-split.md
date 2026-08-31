---
"@nannier-com/lookout": patch
---

The board module now matches the rule it was written to encode: outstanding work
is state, not narration. `report/board-durable` reads the state (the backlog,
each cluster's attempts, the evidence store's mtimes), `report/board-live` reads
the narration (what the run in flight has said about one issue), and
`report/board` is the join plus the two tallies.

The contract moved out too, to `report/board-types`, which imports nothing that
touches a filesystem. The page's client modules import those shapes as types, so
a leaf module is what keeps a browser bundle from dragging in the code that
produces them. It is also the file that changes when the board grows a field,
which two sessions should be able to do without meeting inside the builder.

`report/board.ts` re-exports the contract, so nothing that imported it had to
change. It is now small enough to come off the size-ceiling exemption list.
