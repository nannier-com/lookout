/**
 * The one server option that exists for a human rather than for a computer.
 *
 * `POST /api/pick` opens a native folder picker and does not answer until
 * somebody has chosen a directory. bun closes a connection whose handler has
 * gone quiet for `idleTimeout` seconds, and its default is ten, which is less
 * time than choosing a folder takes. The node server this replaced had no such
 * limit, so the option is not a tuning knob: without it, picking a project from
 * the page fails for anyone who browses rather than types.
 *
 * The exact number is not the contract. The floor is.
 */
import { describe, expect, test } from "bun:test";
import { HTTP_IDLE_SECONDS } from "../src/verbs/ui.js";

describe("how patient the ui server is", () => {
  test("waits far longer than a person takes to pick a folder", () => {
    // A minute is already generous for a folder picker, and bun's default of
    // ten seconds is already too short. Anything in between is a judgement
    // call; anything below is the bug this guards.
    expect(HTTP_IDLE_SECONDS).toBeGreaterThanOrEqual(60);
  });

  test("stays inside what bun will accept", () => {
    // bun refuses anything over 255 with "expects idleTimeout to be 255 or
    // less", and it refuses it by throwing as the server starts, which means
    // `lookout ui` would not come up at all.
    expect(HTTP_IDLE_SECONDS).toBeLessThanOrEqual(255);
  });
});
