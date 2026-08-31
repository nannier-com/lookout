/**
 * The page's markup: a shell, and the assets that dress and drive it.
 *
 * This used to be the whole front end, one 1148-line template literal holding
 * the styles and the script as well. Nothing in the build could read a word of
 * it: no type check, no lint, and a stray escape reached the browser as a
 * syntax error with every gate still green. The styles are files now, the
 * script is a set of real modules under `client/`, and both are served rather than
 * inlined, so tsc checks the page against the very types the server serialises.
 *
 * What is left here is markup, which is the one part with no logic to check:
 * the ids the script paints into, and the shape of the page before any data
 * arrives. It stays a string because it needs one interpolation, and because an
 * HTML file would have to be copied into dist for no gain.
 */
import { LEARNING_HTML } from "./page-learning.js";

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>lookout</title>
<link rel="stylesheet" href="/ui/app.css"/>
<link rel="stylesheet" href="/ui/learning.css"/>
</head><body>
<nav class="rail" aria-label="Areas">
  <button type="button" class="railb" data-view="issues" aria-current="page"
    aria-label="Issues" title="Issues: what lookout found in the application">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/>
      <path d="M6.5 7.5h4M6.5 16.5h4"/></svg></button>
  <button type="button" class="railb" data-view="learning" aria-current="false"
    aria-label="What lookout has changed about itself"
    title="lookout on lookout: its own instructions, and its own source">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 3.2 12.9 8.1 17.8 10 12.9 11.9 11 16.8 9.1 11.9 4.2 10 9.1 8.1Z"/>
      <path d="M18 15.2 18.8 17.2 20.8 18 18.8 18.8 18 20.8 17.2 18.8 15.2 18 17.2 17.2Z"/></svg>
    <i class="rdot" id="railDot" hidden></i></button>
</nav>
<header>
  <div class="navtop">
    <h1><span class="dot"></span><span id="ttl">lookout</span></h1>
    <span class="muted" id="phase"></span>
    <span class="spacer"></span>
    <span class="faint" id="el"></span>
    <div class="toggle" id="toolToggle" role="group" aria-label="open issues in"></div>
  </div>
  <div class="navbottom">
    <div class="filters" id="stats"></div>
    <span class="spacer"></span>
    <span class="where" id="where"></span>
    <button type="button" class="findfix" id="findfix" aria-label="Find and fix"></button>
    <button type="button" class="cog" id="cog" aria-label="Settings" aria-expanded="false"
      title="Settings"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></button>
  </div>
  <div class="settings" id="settings" hidden>
    <label class="srow">
      <span>Project</span>
      <span class="val" id="setProject">not set</span>
      <button type="button" class="mini" id="pickProject">Choose folder</button>
    </label>
    <label class="srow">
      <span>Base URL</span>
      <input type="text" id="setUrl" placeholder="leave empty to use the config"
        spellcheck="false" autocomplete="off">
      <button type="button" class="mini" id="saveUrl">Save</button>
    </label>
    <p class="shint">Overrides where the targets live. The config still supplies
      the routes, viewports, state recipes and sign-in hook.</p>
    <div class="targets" id="setTargets"></div>
  </div>
</header>
<main>
<div id="viewIssues">
<div class="runnote" id="runnote" hidden></div>
<div class="filterbar" id="filterbar" hidden></div>
<section id="issues"><h2>Issues <span class="n" id="bn"></span></h2>
  <div class="board" id="board"></div></section>
</div>
${LEARNING_HTML}
</main>
<script type="module" src="/ui/main.js"></script>
</body></html>`;
