// Who judges a run, and what happens when the flag naming them is wrong.
//
// A flag somebody typed and lookout silently dropped is the failure worth
// testing for here: it would spend one judge's money while its operator
// believed two were watching, and the verdict would be cached under an
// identity claiming both had agreed.
import { describe, expect, test } from "bun:test";
import { rosterKeys, rosterOf } from "../src/check/plan.js";

describe("who judges", () => {
  test("with no challenger it is the one AI, unchanged", () => {
    expect(rosterOf("sonnet")).toEqual({ proposer: { ai: "claude-code", model: "sonnet" } });
  });

  test("a challenger names both the AI and the model it judges with", () => {
    expect(rosterOf("sonnet", "codex:gpt-6-astra")).toEqual({
      proposer: { ai: "claude-code", model: "sonnet" },
      challenger: { ai: "codex", model: "gpt-6-astra" },
    });
  });

  test("an AI lookout cannot judge with is refused, not ignored", () => {
    expect(() => rosterOf("sonnet", "nonesuch:x")).toThrow(/no AI adapter/);
  });

  test("a challenger with no model is refused rather than guessed at", () => {
    // Only one of these CLIs publishes an alias that survives a release, so a
    // bare name would be a guess with a shelf life.
    expect(() => rosterOf("sonnet", "codex")).toThrow(/names no model/);
  });

  test("an AI cannot challenge itself", () => {
    // A second opinion from the same AI on the same evidence is the refuter,
    // which already runs on every finding.
    expect(() => rosterOf("sonnet", "claude-code:opus")).toThrow(/cannot challenge itself/);
  });
});

describe("what the ledger hashes", () => {
  test("every judge and its model, so a swap is a different body of evidence", () => {
    expect(rosterKeys(rosterOf("sonnet", "codex:gpt-x"))).toEqual(["claude-code:sonnet", "codex:gpt-x"]);
  });

  test("and one judge alone is one entry", () => {
    expect(rosterKeys(rosterOf("sonnet"))).toEqual(["claude-code:sonnet"]);
  });
});
