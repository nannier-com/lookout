---
"lookout": patch
---

The queue holds until the agent it launched has gone, not until lookout has
ruled.

Handing an issue over opens a Terminal this server has no handle on, so the
pump had one way to ask whether an agent was still working: the board. An
issue was busy while its attempt count stood still and free the moment a
ruling landed. That reading is wrong in the one direction that costs a working
tree, because a ruling is something an agent asks for in the MIDDLE of its
turn — it runs `verify-fix`, reads the answer, reports, keeps editing.

Both halves of "one at a time" failed on it. A still-open ruling spends an
attempt, which the pump read as the agent having given up, so it opened a
second window on the same issue while the first agent was still in the file;
the two then spent both of that issue's attempts racing each other. And a
settled ruling dropped the head and started the next issue immediately, onto a
checkout the last agent had not left. Observed on a project where four issue
windows were open at once, two of them editing one component.

The handoff script now takes a lease before it starts the tool and drops it
however the window ends, and the pump refuses to hand anything over while one
is held. Liveness is the process rather than the file, so a Terminal that was
force-quit before its trap could run does not park the queue forever: a lease
whose pid is gone is not a lease, and is cleared as it is read.
