---
"@nannier-com/lookout": patch
---

Publish the package publicly. Scoped npm packages default to restricted
access; `publishConfig.access: "public"` in package.json is the mechanism npm
always honors, independent of the changesets-level `access` setting.
