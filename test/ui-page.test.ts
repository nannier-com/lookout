// The page is a shell plus a set of assets, and those are now separate files.
//
// That is a better arrangement than the template literal it replaced, which no
// tool in the build could read: tsc type-checks the client modules and eslint
// lints them. What it introduces is a seam. The markup declares the ids, the
// script paints into them, and nothing but this test notices when one is
// renamed and the other is not, or when a stylesheet is linked that the build
// does not ship.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PAGE } from "../src/ui/page.js";
import { clientAsset, clientDir } from "../src/ui/assets.js";

/** Every file the shell asks the browser to load. */
function linkedAssets(): string[] {
  const names = [...PAGE.matchAll(/(?:href|src)="\/ui\/([^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(names)];
}

/** The client's own source, which is what the server transpiles or serves. */
function clientSources(): { name: string; text: string }[] {
  return readdirSync(clientDir())
    .filter((f) => f.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(clientDir(), name), "utf8") }));
}

describe("the served page", () => {
  test("links assets, and every one of them can be served", () => {
    const linked = linkedAssets();
    // Guard the guard: a shell that stopped linking anything would pass every
    // assertion below while serving a blank page.
    expect(linked).toContain("main.js");
    expect(linked.some((n) => n.endsWith(".css"))).toBe(true);
    for (const name of linked) {
      expect(clientAsset(name), `${name} is linked but cannot be served`).not.toBeNull();
    }
  });

  test("every id the script paints into is declared in the markup", () => {
    const declared = new Set([...PAGE.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!));
    let checked = 0;
    for (const { name, text } of clientSources()) {
      for (const m of text.matchAll(/\bel\("([^"]+)"\)/g)) {
        checked++;
        expect(declared.has(m[1]!), `${name} paints into #${m[1]} and the shell has no such element`).toBe(true);
      }
    }
    // Guard the guard: if the lookup helper is ever renamed, this test would
    // stop finding anything and pass while checking nothing.
    expect(checked).toBeGreaterThan(20);
  });

  test("the client imports nothing at runtime but its own modules", () => {
    const here = new Set(readdirSync(clientDir()).map((f) => f.replace(/\.ts$/, ".js")));
    for (const { name, text } of clientSources()) {
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) {
        const target = m[1]!;
        expect(target.startsWith("./"), `${name} imports ${target} at runtime; the browser cannot load that`).toBe(true);
        expect(here.has(target.slice(2)), `${name} imports ${target}, which is not a client module`).toBe(true);
      }
    }
  });

  test("every client module transpiles to something a browser can load", () => {
    // This is what the server hands the browser when lookout runs from a
    // checkout, so a module that will not transpile is a blank page. The
    // transpiler throws on a syntax error, which is the assertion.
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
    for (const { name, text } of clientSources()) {
      let js = "";
      expect(() => (js = transpiler.transformSync(text)), `${name} does not transpile`).not.toThrow();
      expect(js.length, `${name} transpiled to nothing`).toBeGreaterThan(0);
      // Type-only imports must be erased rather than emitted: a browser asking
      // for a server module gets a 404 and the page never starts.
      expect(js, `${name} still imports a server module after transpiling`).not.toContain('from "../');
    }
  });
});
