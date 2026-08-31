---
"@nannier-com/lookout": patch
---

The MIT grant now covers the source as well as the published package.

The LICENSE that shipped in the tarball carried a carve-out saying the licence
applied to the compiled output alone and that the repository stayed all rights
reserved. It was generated at pack time by `tools/licensegen` and gitignored, so
that a LICENSE file at the repository root could not make a forge read the whole
project as MIT.

That split is gone. LICENSE is a plain MIT grant, committed at the root, and npm
packs it into the tarball on its own without being listed in `files`, so the
generator and the `prepublishOnly` step that ran it are both removed.
