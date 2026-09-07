// What lookout can learn about the Codex CLI without running a model.
//
// The model menu and the version line are read off the install, so these tests
// build fake installs and assert lookout reports what THEY say. The filter is
// the part worth pinning: this CLI lists a text-only model among its visible
// ones, and a judge that cannot see a screenshot has no business in a menu of
// judges.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexModels } from "../src/judge/codex.js";
import { codexAdapter } from "../src/judge/codex.js";

function fakeHome(models: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "lookout-codexhome-"));
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models }));
  return home;
}

describe("what the installed Codex offers", () => {
  test("the visible models it can actually judge with, worst priority last", () => {
    const home = fakeHome([
      { slug: "seeing-b", visibility: "list", priority: 6, input_modalities: ["text", "image"] },
      { slug: "hidden", visibility: "hide", priority: 2, input_modalities: ["text", "image"] },
      { slug: "seeing-a", visibility: "list", priority: 1, input_modalities: ["text", "image"] },
      { slug: "blind", visibility: "list", priority: 3, input_modalities: ["text"] },
    ]);
    // Ordered by the CLI's own priority; the hidden one and the one that cannot
    // take an image are both left out.
    expect(codexModels(home)).toEqual(["seeing-a", "seeing-b"]);
  });

  test("a model that cannot take an image is never offered as a judge", () => {
    // The real install ships exactly this case, and the CLI itself refuses an
    // image to it, so offering it would be offering a judge that cannot see.
    const home = fakeHome([{ slug: "text-only", visibility: "list", input_modalities: ["text"] }]);
    expect(codexModels(home)).toEqual([]);
  });

  test("no cache, or an unreadable one, means no menu rather than a guess", () => {
    expect(codexModels(mkdtempSync(join(tmpdir(), "lookout-empty-")))).toEqual([]);
    const home = mkdtempSync(join(tmpdir(), "lookout-bad-"));
    writeFileSync(join(home, "models_cache.json"), "{ not json");
    expect(codexModels(home)).toEqual([]);
  });

  test("it declares that it cannot say which files it opened", () => {
    // Measured, not assumed: a run that demonstrably read a screenshot and
    // described it emitted only agent_message items. The flag is what turns the
    // clean-without-looking check off explicitly instead of failing it.
    expect(codexAdapter.reportsReads).toBe(false);
    expect(codexAdapter.key).toBe("codex");
  });
});
