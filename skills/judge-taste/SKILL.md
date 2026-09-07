---
name: judge-taste
description: The taste panel of lookout's visual judge, ruling on the defaults a generic build falls into (palette, type, shape, layout template, voice) that the project never declared as its own.
version: 3
output: judge-findings-v2
# Provenance. Every tell below is a paraphrase, as a judging criterion, of an
# audit or anti-pattern rule that two or more of these skills state and none
# contradicts, inverted from guidance for making a page into criteria for
# judging one, the way judge-craft inverted anthropics/skills frontend-design:
# redesign-existing-projects, design-taste-frontend, high-end-visual-design,
# minimalist-ui, industrial-brutalist-ui, stitch-design-taste, gpt-taste,
# image-to-code, imagegen-frontend-web, imagegen-frontend-mobile. None of
# those carries a licence, so none of their prose is reproduced: the rules
# are facts about what reads as generic, restated in lookout's words. What
# the packs contradict each other on (corner radius, gradients, nesting,
# centred heroes, how many calls to action) is never filed by default; it
# belongs to a direction the project declares.
---

- taste: a choice nobody made, visible on this screen as one of the tells
  below. Never a choice you would have made differently: a default a generic
  build falls into, that the project has not declared as its own. And never a
  screen nobody adapted: a control or a hint that is wrong for the device in
  front of you (a keyboard-shortcut chip at phone width, a hover-only
  affordance on a touch screen, a desktop header carried over unchanged) is
  a responsive defect, not a tell, however out of place it looks. It is not
  yours to file under any category, so leave it out of your reply entirely
  and count the shot clean for this pass: the panel that owns responsive
  judges the same shots, and a finding you file under a category that is not
  in your vocabulary is rejected and leaves the shot unruled. Name the tell,
  say what it costs, and use the attribute token
  listed for it; coin a new token only for a shape none of them names. One
  element is one finding: when an element shows two tells, file it once,
  under the attribute that names the cause, never twice. A single tell,
  however prominent, opens at low; medium only when several tells compound
  until the whole view reads as a template; never higher, because nothing
  here is broken.
  - **Template shapes** (attributes feature-triplets, stock-hero,
    pricing-towers, round-stats, card-per-row, section-echo): the view is
    assembled from stock blocks a reader has met on a hundred sites, so the
    shape says "template" before the content says anything. Three equal cards
    in a row, each an icon over a title over two lines of copy, standing in
    for what a product does; a headline, a one-sentence subline and two
    same-weight capsule buttons stacked in the centre with nothing else on the
    first screen; a pricing table of three towers whose middle one is taller;
    three statistics in a row carrying round figures; a bordered, shadowed
    card wrapped around every row of a plain list; the same section shape
    three or more times in a row (image one side, copy the other, then again)
    so the sections cannot be told apart. Say what the block costs on this
    screen: three equal cards give equal weight to three things that are not
    equally important, so the reader compares instead of reads; a repeated
    section shape leaves a reader who scrolls unable to say where on the page
    they are; a card around every list row makes the frames louder than the
    rows. One stock block is not a finding. What you file is a page leaning on
    the block where its own content could have made a decision, and a
    component library's specimen showing a shape because that shape is what
    it documents is never filed.
  - **Generated palette** (ai-gradient, glow-halo, gradient-text,
    blob-backdrop, frost-on-frost, mixed-greys): colour and material that read
    as generated rather than chosen, because they are what the generators
    default to. A violet-to-blue or pink-to-orange wash behind a hero, across
    a button or as a page background; a coloured glow haloing a card or a
    control; headline text filled with a gradient; blurred blobs or orbs
    floating behind content; frosted-glass panels stacked on frosted glass
    with nothing behind them to see through to; warm greys and cool greys
    mixed across one view so its surfaces do not read as one material. Say
    what the decoration does to the reader: it is the first thing the eye
    reads and the content it was meant to dress comes second, or it makes two
    surfaces that should be one system look like two products. Which blue a
    project chose is still nobody's finding, and a brand whose gradient is its
    identity says so in its direction. A wash that leaves text unreadable is
    contrast, and the visibility panel's.
  - **Ornament** (meta-label, fake-marker, idle-badge, scroll-prompt,
    stamp-on-text, wallpaper-numeral, emoji-icon): a small element that means
    nothing and costs the reader a glance to find that out. A label numbering
    what is not a sequence (SECTION 01, QUESTION 05) or naming a layer that
    does not exist; technical-looking markers, revision strings and bracketed
    codes on a page that is not about them; a pill, chip or badge on an
    element that is not new, not in beta and not a status; a "scroll to
    explore" line or a bouncing chevron telling a reader how to use a web
    page; a stamp or badge floating over headline text; a giant outlined
    numeral used as wallpaper; an emoji doing the job of an icon or a bullet.
    Name the element and what a reader would do with it (look for the other
    sections numbered like it, read the marker as a status, try to press the
    badge) and say that nothing answers. When the ornament is one element or
    one kind of element, it is yours. When the whole view is noise with no
    primary, that is composition, and the craft panel files it.
  - **Copy voice** (cliche-copy, apology-state): words that promise everything
    and describe nothing. The vocabulary of generated marketing ("elevate",
    "seamless", "unleash", "next-gen", "revolutionize", "supercharge", "empower
    your"), so a reader has finished the headline and still cannot say what
    the product does; an error or empty state that apologises ("Oops!") or
    cheers ("Success!") instead of saying what happened and what to do next.
    Quote the words you read. Placeholder people, companies, figures and faces
    left on a production surface are copy that was never written, which is
    content, and the text panel's; sample data in a documentation or demo
    context is never filed by anyone, as the never-file list says.
  - **First screen** (headline-wall, hero-clutter, whole-product-first): the
    first viewport of a page (a marketing hero, the top of a dashboard, the
    opening screen of an app) doing too much at once. A headline of so many
    words that it wraps onto four or more lines at any width, so display type
    becomes a paragraph; the space around it filled with pills, star ratings,
    "trusted by" logos too small to read, statistics, badges and a second and
    third call to action, so nothing in the first screen is the point; the
    whole product exposed in the first screen instead of one message and one
    action. Judge it per form factor: at phone the first screen is all a
    reader gets, so file only a headline whose word count makes a paragraph
    at any width, never one that wraps because the viewport is narrow. This is
    not the hierarchy finding. If the eye has nowhere to land first, the craft
    panel files that; you file the crowd of small tells that fills the first
    screen even when the primary is clear.

**On a device.** When the header above the shots says the platform is iOS or
Android, the platform's own conventions are a declared direction and never
tells: the system typeface, capsule and pill controls, large-title and app-bar
headers, tab bars and bottom navigation, tonal surfaces, chips, floating
action buttons, sheet grabbers, system alerts and the way their buttons sit.
What still applies on a device is the generated-output vocabulary: the washes
and glows, gradient-filled headline text, blobs behind content, badges on
elements that are not new or a status, emoji standing in for icons, marketing
clichés and apologies in onboarding, empty and error states, and an opening or
onboarding screen crowded with pills, round statistics and stacked calls to
action. A headline wraps on every phone; only its word count is a tell.

**What excuses a tell.** Two things, and you check both before filing. The
first is the project's own never-file rules, printed with the project's rules
below, which stand over this panel as they do over every other. The second is
the design direction the project declared, when a block headed
"Declared design direction" appears among those rules: it says which of these
shapes are the project's own language (a gradient mesh that is a brand, meta
labels that are a brutalist page's typography, an eyebrow tag that opens every
heading on purpose) and which further shapes it forbids. Read it as the project's word:
its opening description and its tokens (a palette, a type scale, a radius
scale, a spacing scale) are choices, settled; its rules are yours to judge by
where a still can show them; anything it says about motion, hover, code or
performance is not visible and not yours. A tell the direction claims is not
filed; a shape the direction forbids is filed under this category with the
attribute and the consequence the direction gives. Where neither speaks, the
tell is filed.

**Acceptance.** Criteria are the fixed state, decidable from a screenshot of
the same view: "the features section shows something other than three equal
cards in a row at desktop width", "no label reading SECTION 01 or SECTION 02
appears anywhere on the page", "the hero headline occupies three lines or
fewer at desktop width", "the error message names what failed". Never "the
page looks less generic".

{{include:panel-audience.md}}

{{amendments}}
