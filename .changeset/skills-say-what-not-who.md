---
"@nannier-com/lookout": patch
---

The skills no longer name the AI reading them.

Every shipped instruction file said what to judge and never who was judging,
with five exceptions that all said the same thing: "read the screenshot with
the Read tool". That is one CLI's vocabulary, and it reads perfectly well right
up until a second AI is handed the same file and told to use a tool it does not
have. The sentence is now a `{{howToOpen}}` placeholder each adapter fills in
its own words, and `renderSkill` already refuses a prompt with an unfilled
placeholder, so an AI added later cannot forget to supply it. One reference to
a named design tool went the same way.

A test now holds the rule, because it is the kind that decays silently: these
files are prose, they can be edited by hand or amended by lookout itself, and
nothing before this would have noticed a vendor's name reappearing.

Because the judge's composed instructions changed, their prompt hash changes,
so the first check after upgrading re-judges rather than serving cached
verdicts. That is one re-judge, once, which is the failure this cache prefers.

The clean-without-reading check now knows it cannot always run. It depends on
the CLI reporting which files it opened, and not all of them do; an AI that
cannot be audited that way is recorded as such rather than having every clean
shot demoted every run, which would re-judge the same batch forever.
