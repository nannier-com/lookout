// Which failure a self-heal works on: pressure is windowed, healed groups
// settle unless they recur, twice-failed groups wait for a person, and the
// rollback ledger of healing itself is only ever the last thing left.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { activeGroups, compactIncidents, pickGroup, type ActiveGroup } from "../src/skills/heal-select.js";
import { incidentsPath, type Incident } from "../src/skills/incidents.js";
import { tmpProject } from "./tmp-project.js";

const NOW = "2026-08-31T12:00:00.000Z";

function incident(over: Partial<Incident>): Incident {
  return { at: "2026-08-30T00:00:00.000Z", kind: "crash", message: "boom in module 7", ...over };
}

describe("active pressure", () => {
  test("a month-old flood does not outrank a fresh failure", () => {
    const old = Array.from({ length: 10 }, (_, i) =>
      incident({ at: `2026-06-0${(i % 9) + 1}T00:00:00.000Z`, message: "ancient bug at line 4" }),
    );
    const fresh = [incident({ at: "2026-08-30T00:00:00.000Z", message: "new bug at line 9" })];
    const groups = activeGroups([...old, ...fresh], [], { now: NOW });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.message).toContain("new bug");
  });

  test("a healed group settles; one that recurs comes back loudest", () => {
    const healedQuiet = incident({ at: "2026-08-20T00:00:00.000Z", message: "settled bug 1" });
    const healedNoisy = [
      incident({ at: "2026-08-20T00:00:00.000Z", message: "sticky bug 2" }),
      incident({ at: "2026-08-29T00:00:00.000Z", message: "sticky bug 3" }),
    ];
    const heals = [
      { at: "2026-08-25T00:00:00.000Z", kind: "crash" as const, shape: "settled bug N", commit: "aaa" },
      { at: "2026-08-25T00:00:00.000Z", kind: "crash" as const, shape: "sticky bug N", commit: "bbb" },
    ];
    const groups = activeGroups([healedQuiet, ...healedNoisy], heals, { now: NOW });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.message).toBe("sticky bug N");
    expect(groups[0]!.recurred).toBe(true);
    // Only the post-heal occurrence counts as pressure.
    expect(groups[0]!.count).toBe(1);
  });

  test("reverted attempts on a group are counted from the rollback ledger", () => {
    const bug = incident({ message: "cursed bug at line 3" });
    const rollbacks = [1, 2].map((n) =>
      incident({
        at: `2026-08-2${n}T00:00:00.000Z`,
        kind: "self-heal-rollback",
        message: "self-heal reverted: test failed",
        detail: "target: cursed bug at line N | tried something",
      }),
    );
    const groups = activeGroups([bug, ...rollbacks], [], { now: NOW });
    const cursed = groups.find((g) => g.message.includes("cursed"))!;
    expect(cursed.failedAttempts).toBe(2);
  });
});

describe("the pick", () => {
  const group = (over: Partial<ActiveGroup>): ActiveGroup => ({
    kind: "crash",
    message: "m",
    count: 1,
    latest: incident({}),
    recurred: false,
    failedAttempts: 0,
    ...over,
  });

  test("twice-failed groups are skipped with a reason; the next one is picked", () => {
    const { picked, skipped } = pickGroup([
      group({ message: "cursed", count: 9, failedAttempts: 2 }),
      group({ message: "fixable", count: 3 }),
    ]);
    expect(picked?.message).toBe("fixable");
    expect(skipped[0]!.why).toContain("needs a person");
  });

  test("the rollback ledger is only ever the last thing left", () => {
    const { picked } = pickGroup([
      group({ kind: "self-heal-rollback", message: "healing fails", count: 9 }),
      group({ message: "real bug", count: 1 }),
    ]);
    expect(picked?.message).toBe("real bug");
    const { picked: alone } = pickGroup([
      group({ kind: "self-heal-rollback", message: "healing fails", count: 9 }),
    ]);
    expect(alone?.message).toBe("healing fails");
  });
});

describe("compaction", () => {
  test("a small log is untouched; a big one loses only its ancient lines", () => {
    const dir = tmpProject("lookout-compact-").projectDir;
    const lines = [
      ...Array.from({ length: 2100 }, () => incident({ at: "2026-08-01T00:00:00.000Z" })),
      ...Array.from({ length: 5 }, () => incident({ at: "2026-01-01T00:00:00.000Z" })),
    ];
    writeFileSync(incidentsPath(dir), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(compactIncidents(dir, NOW)).toBe(5);
    // Under the threshold now: a second pass changes nothing.
    expect(compactIncidents(dir, NOW)).toBe(0);
  });
});
