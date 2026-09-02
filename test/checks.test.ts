// The off-origin guard: a shot that wandered to another app must never be
// filed under the route that was requested. Pure function, no browser needed.
import { describe, expect, test } from "bun:test";
import { attachConsoleCollector, checkOffOrigin } from "../src/capture/checks.js";

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

describe("the console collector keeps what a fixer needs from an error", () => {
  type Handler = (arg: unknown) => void;
  function fakePage(): { page: Parameters<typeof attachConsoleCollector>[0]; fire: (event: string, arg: unknown) => void } {
    const handlers = new Map<string, Handler>();
    const page = {
      on: (event: string, cb: Handler) => handlers.set(event, cb),
      off: (event: string) => handlers.delete(event),
    } as unknown as Parameters<typeof attachConsoleCollector>[0];
    return { page, fire: (event, arg) => handlers.get(event)?.(arg) };
  }
  const consoleMsg = (text: string, column?: number) => ({
    type: () => "error",
    text: () => text,
    location: () => ({ url: "http://app/main.js", lineNumber: 12, ...(column !== undefined ? { columnNumber: column } : {}) }),
  });

  test("a repeated console error is counted on its first sighting, with its location", () => {
    const { page, fire } = fakePage();
    const c = attachConsoleCollector(page);
    fire("console", consoleMsg("TypeError: x is undefined", 7));
    fire("console", consoleMsg("TypeError: x is undefined", 7));
    fire("console", consoleMsg("TypeError: x is undefined", 7));
    const [f, ...rest] = c.drain();
    expect(rest).toEqual([]);
    expect(f!.meta).toEqual({ url: "http://app/main.js", line: 12, column: 7, repeats: 3 });
  });

  test("a thrown error keeps its stack, bounded to twelve frames", () => {
    const { page, fire } = fakePage();
    const c = attachConsoleCollector(page);
    const err = new Error("boom");
    err.stack = ["Error: boom", ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (http://app/main.js:${i}:1)`)].join("\n");
    fire("pageerror", err);
    const [f] = c.drain();
    expect(f!.type).toBe("page-error");
    expect((f!.meta!.stack as string).split("\n")).toHaveLength(12);
    expect(f!.meta!.stack as string).toContain("at frame10 ");
    expect(f!.meta!.stack as string).not.toContain("at frame11 ");
  });

  test("a failed request keeps its method and resource type", () => {
    const { page, fire } = fakePage();
    const c = attachConsoleCollector(page);
    fire("requestfailed", {
      url: () => "http://app/api/items",
      method: () => "POST",
      resourceType: () => "fetch",
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
    });
    const [f] = c.drain();
    expect(f!.meta).toEqual({ url: "http://app/api/items", errorText: "net::ERR_CONNECTION_REFUSED", method: "POST", resourceType: "fetch" });
  });
});
