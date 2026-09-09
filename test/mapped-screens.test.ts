// A ruling on a finding filed on a mapped state names that screen, so the
// scoped capture replays it; rest, source and unmapped states are left to the
// route capture and the code channel.
import { describe, expect, test } from "bun:test";
import { mappedScreensOf } from "../src/verify/evidence.js";
import type { MapFile } from "../src/map/store.js";

const MAP: MapFile = {
  version: 1,
  project: "app",
  targets: {
    app: {
      url: "http://localhost:1",
      mappedAt: "t",
      skillVersion: 1,
      ai: "claude-code",
      model: "m",
      signature: "s",
      examined: [],
      roots: [
        {
          id: "/",
          kind: "route",
          path: "/",
          title: "Home",
          open: null,
          risk: "safe",
          platforms: ["web"],
          source: { path: "/repo" },
          why: "",
          children: [
            { id: "menu-open", kind: "state", title: "Menu", open: { affordance: { role: "button", name: "Menu" }, outcome: "overlay" }, risk: "safe", platforms: ["web"], source: { path: "/repo" }, why: "", children: [] },
          ],
        },
      ],
      skipped: [],
      notes: [],
    },
  },
};

const member = (route: string, state: string, target = "app") => ({ target, route, state }) as never;

describe("mappedScreensOf", () => {
  test("names each mapped state once, and nothing else", () => {
    const ids = mappedScreensOf({ members: [member("/", "menu-open"), member("/", "menu-open"), member("/", "rest"), member("src/x.tsx", "source"), member("/", "planned-state"), member("/", "menu-open", "other")] }, MAP);
    expect(ids).toEqual(["app|/|menu-open"]);
  });

  test("no map, no screens", () => {
    expect(mappedScreensOf({ members: [member("/", "menu-open")] }, null)).toEqual([]);
  });
});
