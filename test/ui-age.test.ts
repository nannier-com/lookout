/**
 * How the board says how old its evidence is.
 *
 * The card's chip used to render the same formatter the run clock does, so a
 * finding photographed forty minutes ago read `seen 40m17s` and advanced every
 * second, on every card at once, while nothing was running. That is a
 * stopwatch, and it was read as one: a clock counting up against the person who
 * had not fixed the issue yet. An age is a statement about the past, so it is
 * said coarsely and with the word that makes it one.
 */
import { describe, expect, test } from "bun:test";
import { age, dur } from "../src/ui/client/dom.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe("the age on a card", () => {
  test("says nothing precise about the last minute", () => {
    expect(age(0)).toBe("just now");
    expect(age(40 * SEC)).toBe("just now");
    expect(age(59 * SEC)).toBe("just now");
  });

  test("counts in minutes, then hours, then days", () => {
    expect(age(MIN)).toBe("1m ago");
    expect(age(41 * MIN + 17 * SEC)).toBe("41m ago");
    expect(age(59 * MIN)).toBe("59m ago");
    expect(age(HOUR)).toBe("1h ago");
    expect(age(9 * HOUR + 5 * MIN)).toBe("9h ago");
    expect(age(47 * HOUR)).toBe("47h ago");
    expect(age(48 * HOUR)).toBe("2d ago");
  });

  test("holds still for a whole minute, which is the point", () => {
    // The same text for sixty consecutive seconds: what stops the board
    // ticking is that there is nothing new to paint, not a slower interval.
    const said = new Set<string>();
    for (let s = 0; s < 60; s++) said.add(age(41 * MIN + s * SEC));
    expect(said.size).toBe(1);
  });

  test("a clock still ticking keeps its seconds", () => {
    // The header's run clock is the other caller, and it is a live measurement:
    // its seconds are how a reader tells a working run from a hung one.
    expect(dur(41 * MIN + 17 * SEC)).toBe("41m17s");
    expect(dur(41 * MIN + 18 * SEC)).toBe("41m18s");
  });

  test("a clock that has not started yet is not negative", () => {
    expect(age(-5 * MIN)).toBe("just now");
  });
});
