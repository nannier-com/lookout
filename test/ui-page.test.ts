import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pageHtml } from "../src/ui/page.js";
import { clientAsset, clientDir } from "../src/ui/assets.js";

const PAGE = pageHtml();

function linkedAssets(): string[] {
  return [...new Set([...PAGE.matchAll(/(?:href|src)="\/ui\/([^"]+)"/g)].map((match) => match[1]!))];
}

describe("the Vite-built page", () => {
  test("serves the React entry and stylesheet named by its shell", () => {
    const linked = linkedAssets();
    expect(PAGE).toContain('id="root"');
    expect(linked).toContain("main.js");
    expect(linked).toContain("app.css");
    for (const name of linked) expect(clientAsset(name), `${name} is linked but cannot be served`).not.toBeNull();
  });

  test("the browser bundle is self-contained", () => {
    const source = readFileSync(`${clientDir()}/main.js`, "utf8");
    expect(source.length).toBeGreaterThan(100_000);
    expect(source).not.toMatch(/\bfrom\s*["'](?:react|react-native|@nannier-com\/canvas|buffer)/);
    expect(source).not.toContain("/node_modules/");
  });

  test("the bundle contains the product landmarks", () => {
    const source = readFileSync(`${clientDir()}/main.js`, "utf8");
    for (const landmark of ["Issues", "Settings", "Judge", "Delete everything lookout found"]) {
      expect(source, `missing ${landmark}`).toContain(landmark);
    }
  });
});
