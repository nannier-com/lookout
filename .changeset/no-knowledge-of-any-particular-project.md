---
"@nannier-com/lookout": patch
---

lookout no longer carries knowledge of the projects it happened to be built
against, ahead of being open sourced.

It is a project-agnostic tool, but its comments, help text and agent skill had
accumulated references to the author's own private repositories: what they are
called, how many routes they have, which orchestration tool starts them, and
where they sit on one particular machine. None of it changed behaviour, and all
of it would be meaningless or misleading to anyone else reading the source.

- The agent-facing skill listed "wired projects" by name with route counts and
  sign-in details, named a private orchestration tool, and hard-coded a home
  directory as the install path. It now says to read `.lookout/config.ts` and
  `lookout targets` for what a project targets, and to follow whatever
  `startHint` that project sets.
- `lookout --help` used a private app's port and route as its examples
  (`--targets docs --routes /components/button`). It now shows examples a new
  user can recognise.
- `NativeAppConfig` documented its deep-link scheme and bundle id with a real
  private app's identifiers; both are now generic.
- Several module headers credited techniques to a named private project. The
  techniques and the reasoning are kept; the attribution is gone.
- Two release-workflow comments referenced another repository's pipeline.

No behaviour changes. Verified by grepping the whole tracked tree for every
project, tool, host and path name involved and finding nothing left.
