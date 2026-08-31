/**
 * The second area's markup: lookout working on lookout.
 *
 * The board answers "what is wrong with the application". This area answers the
 * other question lookout can be asked, and one nobody could see the answer to
 * before: what has lookout changed about ITSELF. Two verbs do that. `skills improve`
 * amends the instructions the judge runs on, gated by screenshots whose
 * verdicts were settled before the amendment existed. `self-heal` edits lookout's own
 * TypeScript, gated by the type check, the linter, the tests and the build, and
 * reverted whole when any of them fails.
 *
 * Both are the sort of thing you want to be able to look at. An agent editing
 * its own instructions is exactly the change a person should be able to read
 * afterwards, and the record of one that was rolled back is worth as much as
 * the record of one that stuck: it says the gate did its job.
 *
 * Only the markup lives here. Its styles are `client/learning.css` and its script is `client/learning.ts`,
 * the same as every other part of the page.
 */
export const LEARNING_HTML = `
<section id="learning" hidden>
  <div id="lnow"></div>
  <div class="lcols">
    <div class="ltrack">
      <h2>Its instructions <span class="n" id="ln1"></span></h2>
      <p class="lwhat">Every judgement lookout makes is an instruction file it can amend.
        <code>lookout skills improve</code> reads what this project has settled, writes an
        amendment, and keeps it only if screenshots whose verdicts were decided beforehand
        still come out the same.</p>
      <div class="panel" id="lskills"></div>
      <div class="panel gate" id="lgate"></div>
      <div class="panel" id="lhistory"></div>
    </div>
    <div class="ltrack">
      <h2>Its own code <span class="n" id="ln2"></span></h2>
      <p class="lwhat">What has actually gone wrong with lookout, pooled across every project
        on this machine. <code>lookout self-heal</code> reads it, edits lookout's own source,
        and reverts the whole change unless the type check, the linter, the tests and the
        build all pass.</p>
      <div class="panel" id="lincidents"></div>
      <div class="panel" id="lattempts"></div>
      <div class="panel" id="lcommits"></div>
    </div>
  </div>
</section>
`;
