---
"@nannier-com/lookout": patch
---

The page tells Canvas's stylesheet which scheme it is in.

Canvas resolves the colour scheme in React and paints its own components from
it, which is why the dashboard looked dark. Its CSS token layer is a separate
half that keys off a `.dark` class on the root element, and the kit does not put
it there: reaching into the DOM is something Canvas forbids itself, so applying
the class is the consuming app's job and lookout was not doing it.

The effect was a page running Canvas's light custom properties underneath its
dark components. The document behind everything was painted white, which showed
wherever the components did not cover it.

This does not settle the browser's own chrome. Scrollbars, the text caret and
native form controls are painted by the browser, and it decides from the CSS
`color-scheme` property, which nothing in the kit declares yet. That belongs in
Canvas's web stylesheet beside the `.dark` block it already ships.
