---
"@nannier-com/lookout": patch
---

`lookout protocol` names every file in an issue's folder (`frames.json` and
`handoff.command` were missing, and `state.json` now says it holds what was
reported, what lookout observed and the capture the next ruling is measured
against), describes where the working evidence lives (`$LOOKOUT_HOME/
evidence/<project>-<hash>/` with the capture and judge reports, the run log,
the contact sheets, and the `<shot>.png.provenance.json` sidecar beside every
screenshot with its `shotHash` drift check), and says what `--note` becomes,
what a ruling is measured against, that a ruling which does not pass spends an
attempt, and what reopens a blocked issue. Exit 2 is "could not run or could
not rule; no attempt is spent". The README and the skill no longer place the
frozen frames under `evidence/fix-frames/`, where they have not lived since
they moved into the issue's own folder, and the README's fix loop no longer
presents a scoped `check` before `verify-fix` as a step that affects the
ruling.
