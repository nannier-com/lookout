// The pure half of rendering provenance: ranking and capping what the
// in-page walk collected, the PNG-pixel mapping the sidecar's own note
// promises, and the naming convention consumers derive paths from. The
// in-page collector itself needs a browser and is exercised by the capture
// smoke, the harvest.ts split.
import { describe, expect, test } from "bun:test";
import {
  buildSidecar,
  parseSidecar,
  pngBoxOf,
  PROVENANCE_VERSION,
  type ProvenanceElement,
  type RawProvenance,
} from "../src/capture/provenance.js";
import { sidecarRelPath } from "../src/capture/store.js";
import { loadSidecarBeside, provenanceBrief } from "../src/design/provenance-brief.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixCluster } from "../src/fix/cluster.js";

function el(over: Partial<ProvenanceElement> = {}): ProvenanceElement {
  return {
    tag: "div",
    id: null,
    testid: null,
    role: null,
    classes: [],
    text: null,
    cssPath: "div:nth-of-type(1)",
    landmark: false,
    box: { x: 0, y: 0, w: 100, h: 50 },
    components: [],
    ...over,
  };
}

function raw(elements: ProvenanceElement[], over: Partial<RawProvenance> = {}): RawProvenance {
  return {
    devicePixelRatio: 2,
    viewport: { width: 1440, height: 900 },
    scroll: { x: 0, y: 0 },
    document: { width: 1440, height: 3000 },
    originBox: { x: 0, y: 0, w: 1440, h: 3000 },
    elements,
    resolved: {},
    truncated: false,
    ...over,
  };
}

const shot = {
  id: "web/app/root/rest/desktop/dark",
  runId: "web-1",
  capturedAt: "2026-09-01T00:00:00.000Z",
  hash: "abc",
  origin: "document" as const,
  image: { width: 2880, height: 6000 },
};

describe("buildSidecar", () => {
  test("when the cap bites, records that can name code survive", () => {
    const sourced = el({ source: { file: "src/A.tsx", line: 1 }, box: { x: 0, y: 0, w: 10, h: 10 } });
    const named = el({ components: ["Card"], box: { x: 0, y: 0, w: 10, h: 10 } });
    const identified = el({ id: "save", box: { x: 0, y: 0, w: 10, h: 10 } });
    const landmark = el({ landmark: true, box: { x: 0, y: 0, w: 10, h: 10 } });
    const bigAnon = el({ box: { x: 0, y: 0, w: 2000, h: 2000 } });
    const sidecar = buildSidecar(raw([bigAnon, landmark, identified, named, sourced]), shot, {
      maxElements: 3,
    });
    expect(sidecar.elements).toEqual([sourced, named, identified]);
    expect(sidecar.truncated).toBe(true);
  });

  test("under the cap nothing is dropped and truncated stays false", () => {
    const sidecar = buildSidecar(raw([el(), el({ id: "x" })]), shot);
    expect(sidecar.elements).toHaveLength(2);
    expect(sidecar.truncated).toBe(false);
    expect(sidecar.version).toBe(PROVENANCE_VERSION);
    expect(sidecar.shotHash).toBe("abc");
    expect(sidecar.note).toContain("scale = image.width / originBox.w");
  });

  test("selector resolutions follow their elements through the ranking, or drop with them", () => {
    const kept = el({ id: "kept", box: { x: 0, y: 0, w: 10, h: 10 } });
    const capped = el({ box: { x: 0, y: 0, w: 5000, h: 5000 } });
    const sidecar = buildSidecar(
      raw([capped, kept], { resolved: { "#kept": 1, ".capped": 0 } }),
      shot,
      { maxElements: 1 },
    );
    expect(sidecar.elements).toEqual([kept]);
    expect(sidecar.resolved).toEqual({ "#kept": 0 });
  });
});

describe("pngBoxOf", () => {
  test("document origin at dpr 2: CSS px double into PNG px", () => {
    const sidecar = buildSidecar(raw([]), shot);
    expect(pngBoxOf(sidecar, { x: 100, y: 2000, w: 300, h: 150 })).toEqual({
      x: 200,
      y: 4000,
      w: 600,
      h: 300,
    });
  });

  test("element origin subtracts the crop root's box", () => {
    const sidecar = buildSidecar(
      raw([], { originBox: { x: 100, y: 500, w: 400, h: 300 } }),
      { ...shot, origin: "element", image: { width: 800, height: 600 } },
    );
    expect(pngBoxOf(sidecar, { x: 150, y: 550, w: 40, h: 30 })).toEqual({
      x: 100,
      y: 100,
      w: 80,
      h: 60,
    });
  });

  test("a clamped capture trusts the image over the devicePixelRatio", () => {
    // Chromium clamped a very tall page: the PNG is only 1.5x the document
    // width despite dpr 2. The mapping follows the pixels that exist.
    const sidecar = buildSidecar(raw([]), { ...shot, image: { width: 2160, height: 4500 } });
    expect(pngBoxOf(sidecar, { x: 960, y: 0, w: 480, h: 100 })).toEqual({
      x: 1440,
      y: 0,
      w: 720,
      h: 150,
    });
  });
});

describe("provenanceBrief", () => {
  const member = (path: string, hash: string) =>
    ({
      route: "/settings",
      formFactor: "desktop",
      scheme: "dark",
      evidence: [{ shotId: "web/app/settings/rest/desktop/dark", path, hash, runId: "r1" }],
    }) as FixCluster["members"][number];
  const clusterOf = (...members: FixCluster["members"]) => ({ members }) as FixCluster;

  test("digests source hints and component chains, and annotates hash drift", () => {
    const ev = mkdtempSync(join(tmpdir(), "lookout-prov-brief-"));
    mkdirSync(join(ev, "web/app/settings"), { recursive: true });
    const sidecar = buildSidecar(
      raw([
        el({ components: ["SaveButton", "Form"], source: { file: "src/SaveButton.tsx", line: 12 },
             id: "save", text: "Save changes", box: { x: 0, y: 0, w: 100, h: 40 } }),
        el({ components: ["SettingsPage"], box: { x: 0, y: 0, w: 1440, h: 900 } }),
        el({ box: { x: 0, y: 0, w: 50, h: 50 } }),
      ]),
      shot,
    );
    const rel = "web/app/settings/rest--desktop-dark.png";
    writeFileSync(join(ev, `${rel}.provenance.json`), JSON.stringify(sidecar));

    const fresh = provenanceBrief(ev, clusterOf(member(rel, "abc")));
    expect(fresh).toContain("SaveButton < Form  src/SaveButton.tsx:12");
    expect(fresh).toContain("SettingsPage");
    expect(fresh).toContain('"Save changes"');
    expect(fresh).not.toContain("re-captured");

    const drifted = provenanceBrief(ev, clusterOf(member(rel, "other-hash")));
    expect(drifted).toContain("re-captured since this evidence");
  });

  test("empty when nothing was captured, and a foreign version reads as nothing", () => {
    const ev = mkdtempSync(join(tmpdir(), "lookout-prov-none-"));
    expect(provenanceBrief(ev, clusterOf(member("web/app/x/rest--desktop-dark.png", "h")))).toBe("");
    mkdirSync(join(ev, "web/app/x"), { recursive: true });
    const rel = "web/app/x/rest--desktop-dark.png";
    writeFileSync(
      join(ev, `${rel}.provenance.json`),
      JSON.stringify({ ...buildSidecar(raw([el({ id: "a" })]), shot), version: 99 }),
    );
    expect(loadSidecarBeside(ev, rel)).toBeNull();
    expect(provenanceBrief(ev, clusterOf(member(rel, "h")))).toBe("");
  });
});

describe("the sidecar on disk", () => {
  test("is named by appending to the PNG path, web axes included", () => {
    expect(
      sidecarRelPath({
        target: "app",
        route: "/settings/profile",
        state: "rest",
        platform: "web",
        formFactor: "desktop",
        scheme: "dark",
      }),
    ).toBe("web/app/settings-profile/rest--desktop-dark.png.provenance.json");
  });

  test("a foreign version is discarded rather than misread", () => {
    const good = buildSidecar(raw([]), shot);
    expect(parseSidecar(JSON.stringify(good))?.shotId).toBe(shot.id);
    expect(parseSidecar(JSON.stringify({ ...good, version: 2 }))).toBeNull();
    expect(parseSidecar("not json")).toBeNull();
  });
});
