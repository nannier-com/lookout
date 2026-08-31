---
"@nannier-com/lookout": patch
---

The page's stylesheet follows its script. `client/shell.css` carries the colour
tokens, the rail and the run controls; `client/board.css` carries a card and
everything inside one. They are edited for different reasons, and after the
script became nine modules the single stylesheet was the last file two people
doing unrelated UI work would have collided in.

Also documents a verification step that was missing: the page's assets are files
the build copies, so a build that stopped copying them would pass every gate and
serve a blank page to anyone who installed the package. Packing the tarball and
running it from a throwaway install is now written down as the check, and was
run: `npm pack` ships all eleven client files, and the ui served from the
installed binary passes the same sixteen interaction checks, serving its script
byte for byte from the built module rather than transpiling it.
