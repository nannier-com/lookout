---
"@nannier-com/lookout": patch
---

**lookout knows which fold a project is judged in.** A web application is photographed at desktop, tablet and phone; a native or React Native application is photographed on iOS and Android devices. `lookout targets` now says which fold a project is in and why (a `react-native` dependency, an `ios/` Xcode project, a Gradle build, the config's `native` block), a configured native platform joins the default walk without `--platforms`, and a new `platforms` key in `lookout.config.ts` decides outright. The ordered form-factor set lives in one exported constant, `FORM_FACTORS`, so a run narrowed with `--viewports` walks in the same order as a full one whatever order the flag listed, and an unknown value is answered with the set. `capture --json` reports the platforms it walked.
