---
"@nannier-com/lookout": minor
---

Minor justification (new user-visible capability): **accessibility checks now cover the phone and tablet layouts.** The axe scan used to run once per route at the widest form factor, so a hamburger button with no accessible name, or content a media query pushes off screen, was never checked. Under the default `--axe route` the scan now runs at every form factor's rest shot: a violation is filed at the widest form factor that shows it and, at each narrower one, only the nodes the wider layouts did not show, so a phone-only defect is filed once and a defect shared by every width is not filed three times. `--axe all` files every violation on every form factor; `--axe off` is unchanged. Measured on a one-route page: 4 s with the scan at three form factors against 3 s with it off. Animation sampling and the navigation harvest deliberately stay at the widest form factor, where the full set of controls is visible.
