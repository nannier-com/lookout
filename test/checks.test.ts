// The off-origin guard: a shot that wandered to another app must never be
// filed under the route that was requested. Pure function, no browser needed.
import { describe, expect, test } from "bun:test";
import { checkOffOrigin } from "../src/capture/checks.js";

describe("checkOffOrigin", () => {
  test("stays silent on the target's own origin", () => {
    expect(checkOffOrigin("http://localhost:3000/dashboard", "http://localhost:3000")).toEqual([]);
  });

  test("stays silent on a same-origin redirect", () => {
    expect(checkOffOrigin("http://localhost:3000/login?next=%2F", "http://localhost:3000")).toEqual([]);
  });

  test("reports a different port as off-origin", () => {
    const [f] = checkOffOrigin("http://localhost:3200/login?flow=abc", "http://localhost:3000");
    expect(f?.type).toBe("off-origin");
    expect(f?.severity).toBe("error");
    expect(f?.meta?.landed).toBe("http://localhost:3200");
    expect(f?.meta?.expected).toBe("http://localhost:3000");
  });

  test("reports a different host as off-origin", () => {
    const [f] = checkOffOrigin("https://accounts.example.com/sso", "http://localhost:3000");
    expect(f?.type).toBe("off-origin");
  });

  test("stays silent when a url cannot be parsed", () => {
    expect(checkOffOrigin("about:blank", "not a url")).toEqual([]);
  });
});
