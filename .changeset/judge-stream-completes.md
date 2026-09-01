---
"@nannier-com/lookout": patch
---

A judge call finishes when the model finishes, not ten minutes later.

Every AI call lookout makes went through `execFile`, whose callback fires when
the subprocess's stdout reaches end-of-file rather than when the subprocess is
done. Those are different moments: anything that outlives the CLI while holding
the pipe it inherited holds that end-of-file open with it. Measured on a real
run, the first judge call of every judging phase returned its verdict in about
a minute and then sat there until the ten-minute timeout released it, three
times out of three, which on a thirteen-route check is close to two hours of
waiting for nothing. Nothing surfaced, either: the child had exited cleanly with
its answer buffered, so the reply was correct and no error was ever raised.

The CLI is now asked for `stream-json` and driven with `spawn`, and the call
completes on the CLI's own result message. That makes the end of the answer
something lookout sees rather than something it waits for, whatever else is
still holding the pipe. Reading the stream is also what lets a caller watch a
call in progress: `invokeClaude` takes an `onSay` callback that is handed the
reply as it is written and each tool call as it is made.
