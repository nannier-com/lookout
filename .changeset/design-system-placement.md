---
"@nannier-com/lookout": minor
---

Find the project's design system, and say where a visual fix belongs.

Minor because this adds user-visible capability rather than changing existing
behaviour: a new verb (`lookout design-system`), a new configuration block
(`designSystem`), a new skill (`design-placement`), and a new finding channel.
Nothing existing changes shape for a project without a design system, where the
scan reports none and every document renders exactly as it did before.

A defect is found on a screen and fixed in a component, and in any project with
a component kit those are rarely the same file, often not even the same package.
A fix session that does not know this patches the screen: the kit stays broken
for every other consumer, the screen gains an override that will drift, and the
next person to touch the component cannot see why it is special.

So lookout now reads the repository and works out what it is built from,
deterministically, from manifests and directory layout rather than by asking a
model. It resolves a design system's own repository, a workspace-local kit, a
vendored kit such as shadcn/ui, and an installed one, and records the bit that
decides everything downstream: whether the kit's source is this repository's to
edit, or an installed dependency whose fix belongs in the application's use of
it and never in `node_modules`.

Every issue filed in such a project gains a "Where this belongs" section naming
the file to change, why there rather than the other place, how many other
callers a kit change would reach, and what else it moves. That answer comes from
`design-placement`, lookout's sixth skill and the first allowed to read the
target repository, read-only and in a pass kept separate from judging so that
the visual judge stays as isolated from a repository's own instructions as it
has always been.

lookout also now files what it can see without a screenshot. A control an
application hand-rolls out of raw elements, where its kit already provides one,
is a real defect no photograph can show, so it is filed on the previously
reserved `code` channel and ruled by re-reading the source. `verify-fix` closes
it on evidence exactly like any other issue: the fixer still does not get to
grade their own work.

New configuration, for a kit the scan cannot name on its own:

```ts
designSystem: {
  name: "House",
  packageRoot: "../packages/ui",
  componentRoots: ["../packages/ui/src/components"],
  importPrefixes: ["@house/ui"],
}
```
