// Detection is a fact-finder over a real directory tree, so the fixtures are
// real directory trees. Mocking the filesystem here would test the mock.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detect, importsOf, scanHandRolls } from "../src/design/detect.js";
import { applyDeclaration } from "../src/design/resolve.js";
import { tmpProject } from "./tmp-project.js";
import type { ResolvedConfig } from "../src/types.js";

function write(dir: string, rel: string, text: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function pkg(dir: string, body: Record<string, unknown>): void {
  write(dir, "package.json", JSON.stringify(body, null, 2));
}

describe("importsOf", () => {
  test("reads static imports, re-exports and require", () => {
    const specs = importsOf(
      `import { Button } from "@acme/ui";\nexport * from "./local";\nconst x = require("antd");`,
    );
    expect(specs).toContain("@acme/ui");
    expect(specs).toContain("./local");
    expect(specs).toContain("antd");
  });
});

describe("detect", () => {
  test("names an installed kit from the dependency list", async () => {
    const r = tmpProject("lookout-mui-");
    pkg(r.projectDir, { name: "app", dependencies: { "@mui/material": "^6.0.0" } });
    write(r.projectDir, "src/screens/Home.tsx", `import { Button } from "@mui/material";\nexport const Home = () => <Button/>;`);

    const inv = await detect(r);
    expect(inv.kits[0]?.name).toBe("MUI");
    expect(inv.kits[0]?.via).toBe("dependency");
    // Installed, not vendored: the fix does not belong in this repository.
    expect(inv.kits[0]?.editable).toBe(false);
    expect(inv.adoption?.fromKit).toBe(1);
  });

  test("finds a vendored kit by its marker file and locates its components", async () => {
    const r = tmpProject("lookout-shadcn-");
    pkg(r.projectDir, { name: "app", dependencies: { "@radix-ui/react-dialog": "^1" } });
    write(r.projectDir, "components.json", "{}");
    write(r.projectDir, "src/components/ui/button.tsx", "export const Button = () => null;");
    write(r.projectDir, "src/app/page.tsx", `import { Button } from "@/components/ui/button";`);

    const inv = await detect(r);
    // shadcn is listed before Radix precisely so this does not come back Radix.
    expect(inv.kits[0]?.id).toBe("shadcn");
    expect(inv.kits[0]?.editable).toBe(true);
    expect(inv.kits[0]?.componentRoots.some((p) => p.endsWith("src/components/ui"))).toBe(true);
  });

  test("finds a workspace-local kit by what the app actually imports", async () => {
    const r = tmpProject("lookout-mono-");
    const root = r.projectDir;
    write(root, ".git/HEAD", "ref: refs/heads/main\n");
    pkg(root, { name: "monorepo", workspaces: ["packages/*"] });
    pkg(join(root, "packages/kit"), { name: "@acme/kit" });
    write(root, "packages/kit/src/atoms/Button.tsx", "export const Button = () => null;");
    pkg(join(root, "packages/util"), { name: "@acme/util" });
    write(root, "packages/util/src/index.ts", "export const noop = () => {};");
    write(root, "src/screens/Settings.tsx", `import { Button } from "@acme/kit";\nimport { noop } from "@acme/util";`);

    const inv = await detect(r);
    const kit = inv.kits.find((k) => k.id === "@acme/kit");
    expect(kit).toBeDefined();
    expect(kit!.editable).toBe(true);
    expect(kit!.componentRoots.some((p) => p.endsWith("atoms"))).toBe(true);
    // @acme/util has no component directory, so it is not mistaken for a kit.
    expect(inv.kits.some((k) => k.id === "@acme/util")).toBe(false);
  });

  test("reports no design system, with a note, rather than guessing", async () => {
    const r = tmpProject("lookout-none-");
    pkg(r.projectDir, { name: "app", dependencies: { express: "^4" } });
    write(r.projectDir, "src/index.ts", `import express from "express";`);

    const inv = await detect(r);
    expect(inv.kits).toHaveLength(0);
    expect(inv.notes.join(" ")).toContain("No design system detected");
  });

  test("finds a token layer independently of any component kit", async () => {
    const r = tmpProject("lookout-tw-");
    pkg(r.projectDir, { name: "app" });
    write(r.projectDir, "tailwind.config.ts", "export default {};");
    const inv = await detect(r);
    expect(inv.tokens.map((t) => t.id)).toContain("tailwind");
  });

  test("notes a kit that is installed but unused rather than claiming adoption", async () => {
    const r = tmpProject("lookout-unused-");
    pkg(r.projectDir, { name: "app", dependencies: { "@chakra-ui/react": "^2" } });
    write(r.projectDir, "src/screens/Home.tsx", `import { useState } from "react";`);
    const inv = await detect(r);
    expect(inv.kits[0]?.name).toBe("Chakra UI");
    expect(inv.adoption?.fromKit).toBe(0);
    expect(inv.notes.join(" ")).toContain("imports nothing from it");
  });
});

describe("scanHandRolls", () => {
  const kits = [
    {
      id: "@acme/kit",
      name: "@acme/kit",
      via: "inferred" as const,
      evidence: [],
      editable: true,
      packageRoot: "/nowhere/packages/kit",
      componentRoots: ["/nowhere/packages/kit/src/atoms"],
      importPrefixes: ["@acme/kit"],
    },
  ];

  test("flags a control built from raw elements in an app that has a kit", async () => {
    const r = tmpProject("lookout-hand-");
    write(r.projectDir, "src/screens/Thing.tsx", `export function SubmitButton() {\n  return <button className="x">go</button>;\n}`);
    const found = await scanHandRolls([join(r.projectDir, "src")], kits, r.projectDir);
    expect(found).toHaveLength(1);
    expect(found[0]!.symbol).toBe("SubmitButton");
    expect(found[0]!.candidate).toBe("Button");
    expect(found[0]!.elements).toContain("button");
  });

  test("does not flag a component that composes the kit", async () => {
    const r = tmpProject("lookout-compose-");
    write(r.projectDir, "src/screens/Ok.tsx", `import { Button } from "@acme/kit";\nexport function SaveButton() {\n  return <Button>save</Button>;\n}`);
    const found = await scanHandRolls([join(r.projectDir, "src")], kits, r.projectDir);
    expect(found).toHaveLength(0);
  });

  test("does not flag the kit's own source", async () => {
    const r = tmpProject("lookout-kitsrc-");
    const kitRoot = join(r.projectDir, "packages/kit");
    write(r.projectDir, "packages/kit/src/atoms/Button.tsx", `export function Button() {\n  return <button/>;\n}`);
    const local = [{ ...kits[0]!, packageRoot: kitRoot, componentRoots: [join(kitRoot, "src/atoms")] }];
    const found = await scanHandRolls([join(r.projectDir, "packages")], local, r.projectDir);
    expect(found).toHaveLength(0);
  });

  test("finds nothing when the project has no kit to duplicate", async () => {
    const r = tmpProject("lookout-nokit-");
    write(r.projectDir, "src/Thing.tsx", `export function Button() { return <button/>; }`);
    const found = await scanHandRolls([join(r.projectDir, "src")], [], r.projectDir);
    expect(found).toHaveLength(0);
  });
});

describe("applyDeclaration", () => {
  function base(r: ResolvedConfig) {
    return {
      schema: 1 as const,
      at: "now",
      project: r.project,
      kits: [],
      tokens: [],
      appRoots: [],
      handRolls: [],
      adoption: null,
      notes: [],
    };
  }

  test("a declared kit outranks anything detected and resolves paths against the config", async () => {
    const r = tmpProject("lookout-decl-");
    mkdirSync(join(r.projectDir, "kit/src"), { recursive: true });
    const inv = applyDeclaration(r, base(r), {
      name: "House",
      packageRoot: "../kit",
      componentRoots: ["../kit/src"],
      importPrefixes: ["@house/ui"],
    });
    expect(inv.kits[0]!.name).toBe("House");
    expect(inv.kits[0]!.via).toBe("declared");
    expect(inv.kits[0]!.editable).toBe(true);
    expect(inv.kits[0]!.packageRoot).toBe(join(r.projectDir, "kit"));
  });

  test("notes a declared path that is not on disk instead of trusting it", async () => {
    const r = tmpProject("lookout-decl-missing-");
    const inv = applyDeclaration(r, base(r), { name: "Ghost", packageRoot: "../nope" });
    expect(inv.notes.join(" ")).toContain("does not exist on disk");
  });
});

describe("the project as its own design system", () => {
  test("a kit's own repository names itself, editable, with its component roots", async () => {
    const r = tmpProject("lookout-selfkit-");
    pkg(r.projectDir, { name: "@acme/canvas", main: "./dist/index.js" });
    write(r.projectDir, "src/atoms/Button.tsx", "export const Button = () => null;");
    write(r.projectDir, "src/molecules/Field.tsx", "export const Field = () => null;");

    const inv = await detect(r);
    expect(inv.kits[0]?.id).toBe("@acme/canvas");
    expect(inv.kits[0]?.editable).toBe(true);
    expect(inv.kits[0]?.packageRoot).toBe(r.projectDir);
    expect(inv.kits[0]?.componentRoots.some((p) => p.endsWith("atoms"))).toBe(true);
  });

  test("an ordinary app with a components directory is not called a design system", async () => {
    const r = tmpProject("lookout-app-");
    // No entry point and no atomic directories: an application, not a library.
    pkg(r.projectDir, { name: "my-app", private: true });
    write(r.projectDir, "src/components/Thing.tsx", "export const Thing = () => null;");
    const inv = await detect(r);
    expect(inv.kits).toHaveLength(0);
  });

  test("the in-repo kit outranks an upstream one it is built on", async () => {
    const r = tmpProject("lookout-onthopof-");
    pkg(r.projectDir, {
      name: "@acme/kit",
      main: "./dist/index.js",
      dependencies: { "@radix-ui/react-dialog": "^1" },
    });
    write(r.projectDir, "src/atoms/Dialog.tsx", `import * as D from "@radix-ui/react-dialog";`);

    const inv = await detect(r);
    expect(inv.kits[0]?.id).toBe("@acme/kit");
    expect(inv.kits.map((k) => k.id)).toContain("radix");
  });
});

describe("adoption reporting", () => {
  test("is suppressed for a kit's own repository, where the figure is meaningless", async () => {
    const r = tmpProject("lookout-selfadopt-");
    pkg(r.projectDir, { name: "@acme/canvas", main: "./dist/index.js" });
    write(r.projectDir, "src/atoms/Button.tsx", `import { useState } from "react";`);
    write(r.projectDir, "src/molecules/Field.tsx", `import { useMemo } from "react";`);

    const inv = await detect(r);
    expect(inv.kits[0]?.id).toBe("@acme/canvas");
    expect(inv.adoption).toBeNull();
    // And it must not claim the kit is installed-but-unused.
    expect(inv.notes.join(" ")).not.toContain("imports nothing from it");
  });
});

describe("hand-roll scanning inside a kit's own repository", () => {
  test("scans the kit's own app while still exempting the kit's components", async () => {
    const r = tmpProject("lookout-kitrepo-");
    pkg(r.projectDir, { name: "@acme/kit", main: "./dist/index.js" });
    // The kit itself: raw elements by definition, and never a finding.
    write(r.projectDir, "src/atoms/Button.tsx", `export function Button() { return <button/>; }`);
    write(r.projectDir, "src/atoms/Card.tsx", `export function Card() { return <div/>; }`);
    // The kit's own docs app, duplicating what it ships. That IS a finding:
    // the package root is the whole repo here, so an exclusion by package root
    // would have hidden it.
    write(r.projectDir, "app/Demo.tsx", `export function DemoButton() { return <button/>; }`);

    const inv = await detect(r);
    expect(inv.handRolls.map((h) => h.symbol)).toEqual(["DemoButton"]);
  });
});

describe("hand-roll evidence accuracy", () => {
  test("each component reports only the elements in its own body", async () => {
    const r = tmpProject("lookout-bounds-");
    pkg(r.projectDir, { name: "app", private: true, dependencies: { "@mui/material": "^6" } });
    write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `export function PayButton() {\n  return <button/>;\n}\n\nexport function PriceCard() {\n  return <div><span/></div>;\n}\n`,
    );

    const inv = await detect(r);
    const pay = inv.handRolls.find((h) => h.symbol === "PayButton")!;
    const card = inv.handRolls.find((h) => h.symbol === "PriceCard")!;
    // PayButton must not be credited with the div and span below it.
    expect(pay.elements).toEqual(["button"]);
    expect(card.elements.sort()).toEqual(["div", "span"]);
    expect(pay.line).toBeLessThan(card.line);
  });
});
