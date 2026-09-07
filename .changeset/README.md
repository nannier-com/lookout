# Changesets

Release notes live here as pending changeset files; CI consumes them.

- patch: bug fixes, internal refactors, docs updates. The default.
- minor: a new verb, a new public option, a new supported platform. The changeset
  body must open with "Minor justification (new public capability): ...".
- major: blocked by CI, including manual release runs. A breaking release needs
  the owner's explicit authorization for a separate release-policy change.

CI and Release share `.github/actions/validate`: typecheck, lint, tests and build.
Release prepares a version commit from current main, validates it, and pushes it
before publishing. If main advances during validation, the push is rejected and
that run publishes nothing; the newer push has its own release run. No rebase is
allowed after validation. Manual runs use the same gate and only run on main.

If a release fails after its version commit reached main, fix the cause and add
a new patch changeset. Publishing stays in CI. A run with no pending changesets
also validates before asking Changesets to publish any version missing from npm;
an already published version is left alone.
