// What a question is photographed in. The verb used to narrow to desktop and
// phone and never said so; now the capture default (every form factor) rules
// and only the scheme is defaulted, to dark.
import { describe, expect, test } from "bun:test";
import { ASK_DEFAULT_SCHEMES, askFlags } from "../src/verbs/ask.js";

describe("askFlags", () => {
  test("no flags: dark only, and the form factors left to the capture default", () => {
    expect(askFlags({})).toEqual({ schemes: "dark" });
    expect(askFlags({}).viewports).toBeUndefined();
  });

  test("a scheme flag wins", () => {
    expect(askFlags({ schemes: "light" })).toEqual({ schemes: "light" });
    expect(askFlags({ schemes: "dark,light" }).schemes).toBe("dark,light");
  });

  test("a viewport flag passes through untouched", () => {
    expect(askFlags({ viewports: "phone" })).toEqual({ viewports: "phone", schemes: "dark" });
  });

  test("the default scheme is dark, as a literal", () => {
    expect([...ASK_DEFAULT_SCHEMES]).toEqual(["dark"]);
  });
});
