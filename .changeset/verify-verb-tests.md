---
"@nannier-com/lookout": patch
---

Pin the `lookout verify` verb's contract with tests: the flag guards, file-vs-inline criteria resolution, the verify-report.json shape gatherSignals consumes, the exit-code contract (a failed criterion exits 1; not-verifiable exits 1 only under --strict), and the MAX_VERIFY_SHOTS cap refusing before any model call. The mock claude gains a MOCK_CRITERIA reply override for verdict shapes the default reply cannot express.
