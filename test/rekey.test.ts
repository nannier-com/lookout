// The collapse: a shell finding folding its route-scoped history into itself.
// Every rule here is about not losing an adjudication, so the fold table gets
// its own tests and the merge integration proves the ordering: absorption runs
// before the by-design branch, so an absorbed ruling suppresses the sighting.
import { describe, expect, test } from "bun:test";
import { emptyBacklog, type BacklogFinding } from "../src/backlog/lib.js";
import { mergeFindings } from "../src/backlog/merge.js";
import { absorbLegacy, runOrder } from "../src/backlog/rekey.js";

const NOW = "2026-09-01T00:00:00.000Z";

/** A route-scoped legacy record, as the pre-region code filed it. */
function legacy(route: string, over: Partial<BacklogFinding> = {}): BacklogFinding {
  const slug = route.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-") || "root";
  return {
    fingerprint: `app.${slug}.rest.phone.dark.layout-overflow.avatar-clipped`,
    target: "app",
    route,
    state: "rest",
    platform: "web",
    formFactor: "phone",
    scheme: "dark",
    category: "layout-overflow",
    attribute: "avatar-clipped",
    severity: "high",
    status: "open",
    reason: null,
    title: "Avatar clipped in the top bar",
    problem: "p",
    expected: "e",
    observed: "o",
    channel: "ai",
    confidence: "high",
    verified: false,
    acceptance: [],
    evidence: [{ shotId: `web/app/${slug}/rest/phone/dark`, path: `${slug}.png`, hash: `h-${slug}`, runId: "web-20260801-090000" }],
    firstSeen: "web-20260801-090000",
    lastSeen: "web-20260801-090000",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  };
}

/** The same defect arriving under its shell identity. */
function incomingShell() {
  return {
    fingerprint: "app.@shell-header.rest.phone.dark.layout-overflow.avatar-clipped",
    target: "app",
    route: "/settings",
    state: "rest",
    platform: "web" as const,
    formFactor: "phone" as const,
    scheme: "dark" as const,
    region: "shell-header" as const,
    category: "layout-overflow" as BacklogFinding["category"],
    attribute: "avatar-clipped",
    severity: "high" as const,
    title: "Avatar clipped in the top bar",
    problem: "p2",
    expected: "e2",
    observed: "o2",
    channel: "ai" as const,
    confidence: "high" as const,
    verified: true,
    acceptance: [],
    evidence: [{ shotId: "web/app/settings/rest/phone/dark", path: "settings.png", hash: "h-new", runId: "check-20260901-100000" }],
  };
}

function seeded(records: BacklogFinding[]) {
  const b = emptyBacklog("test", NOW);
  for (const r of records) b.findings[r.fingerprint] = r;
  return b;
}

describe("runOrder", () => {
  test("orders across the run-id families, unknowns oldest", () => {
    expect(runOrder("web-20260801-090000") < runOrder("check-20260901-100000")).toBe(true);
    expect(runOrder("mystery")).toBe("");
  });
});

describe("absorbLegacy", () => {
  test("folds every route sibling into one shell record with the union of history", () => {
    const a = legacy("/dashboard", { firstSeen: "web-20260710-080000", fixAttempts: 2 });
    const c = legacy("/clients", { firstSeen: "check-20260820-120000", verified: true });
    const b = seeded([a, c]);
    const folded = absorbLegacy(b, incomingShell());
    expect(folded).toBeDefined();
    expect(Object.keys(b.findings)).toEqual([
      "app.@shell-header.rest.phone.dark.layout-overflow.avatar-clipped",
    ]);
    expect(folded!.route).toBe("/dashboard"); // oldest sibling, kept as provenance
    expect(folded!.seenRoutes).toEqual(["/clients", "/dashboard", "/settings"]);
    expect(folded!.absorbed).toEqual([a.fingerprint, c.fingerprint].sort());
    expect(folded!.firstSeen).toBe("web-20260710-080000");
    expect(folded!.fixAttempts).toBe(2);
    expect(folded!.verified).toBe(true);
  });

  test("status folds by precedence: by-design over blocked over open over fixed", () => {
    const cases: [BacklogFinding["status"][], BacklogFinding["status"]][] = [
      [["open", "fixed"], "open"],
      [["fixed", "blocked", "open"], "blocked"],
      [["blocked", "by-design", "open"], "by-design"],
      [["fixed", "fixed"], "fixed"],
    ];
    for (const [statuses, want] of cases) {
      const records = statuses.map((status, i) =>
        legacy(`/r${i}`, {
          status,
          reason: status === "by-design" || status === "blocked" ? `ruled-${i}` : null,
          fixedIn: status === "fixed" ? { commit: `c${i}`, runId: `web-2026080${i + 1}-090000` } : null,
        }),
      );
      const b = seeded(records);
      const folded = absorbLegacy(b, incomingShell())!;
      expect(folded.status).toBe(want);
      if (want === "by-design" || want === "blocked") {
        expect(folded.reason).toMatch(/^absorbed from app\./);
        expect(folded.reason).toContain("ruled-");
      } else {
        expect(folded.reason).toBeNull();
      }
      if (want === "fixed") expect(folded.fixedIn).not.toBeNull();
      else expect(folded.fixedIn).toBeNull();
    }
  });

  test("an explicit content answer is never absorbed", () => {
    const answered = legacy("/dashboard", { region: "content" });
    const silent = legacy("/clients");
    const b = seeded([answered, silent]);
    const folded = absorbLegacy(b, incomingShell())!;
    expect(folded.absorbed).toEqual([silent.fingerprint]);
    expect(b.findings[answered.fingerprint]).toBeDefined();
  });

  test("evidence unions by hash, newest six kept", () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      legacy(`/r${i}`, {
        evidence: [{ shotId: `s${i}`, path: `p${i}.png`, hash: `h${i}`, runId: `web-2026081${i}-090000` }],
      }),
    );
    const folded = absorbLegacy(seeded(records), incomingShell())!;
    expect(folded.evidence.length).toBe(6);
    expect(folded.evidence[0]!.hash).toBe("h2");
    expect(folded.evidence[5]!.hash).toBe("h7");
  });

  test("does not fire on a route-keyed fingerprint, flag off", () => {
    const b = seeded([legacy("/clients")]);
    const f = { ...incomingShell(), fingerprint: "app.settings.rest.phone.dark.layout-overflow.avatar-clipped" };
    expect(absorbLegacy(b, f)).toBeUndefined();
    expect(Object.keys(b.findings).length).toBe(1);
  });

  test("nothing to fold answers undefined and touches nothing", () => {
    const b = seeded([legacy("/clients", { formFactor: "desktop" })]);
    expect(absorbLegacy(b, incomingShell())).toBeUndefined();
    expect(Object.keys(b.findings).length).toBe(1);
  });
});

describe("absorption through the merge state machine", () => {
  test("an absorbed by-design suppresses the fresh sighting", () => {
    const ruled = legacy("/dashboard", { status: "by-design", reason: "intended density" });
    const b = seeded([ruled, legacy("/clients")]);
    const res = mergeFindings(b, [incomingShell()], "check-20260901-100000", NOW);
    expect(res.absorbed).toEqual([
      {
        fingerprint: "app.@shell-header.rest.phone.dark.layout-overflow.avatar-clipped",
        from: [ruled.fingerprint, "app.clients.rest.phone.dark.layout-overflow.avatar-clipped"].sort(),
      },
    ]);
    expect(res.suppressed.length).toBe(1);
    expect(res.added.length).toBe(0);
    const rec = b.findings["app.@shell-header.rest.phone.dark.layout-overflow.avatar-clipped"]!;
    expect(rec.status).toBe("by-design");
  });

  test("an absorbed fixed reopens; absorbing is idempotent across runs", () => {
    const fixed = legacy("/dashboard", {
      status: "fixed",
      fixedIn: { commit: "abc", runId: "web-20260810-090000" },
    });
    const b = seeded([fixed]);
    const r1 = mergeFindings(b, [incomingShell()], "check-20260901-100000", NOW);
    expect(r1.absorbed.length).toBe(1);
    expect(r1.reopened.length).toBe(1);
    const r2 = mergeFindings(b, [incomingShell()], "check-20260901-110000", NOW);
    expect(r2.absorbed.length).toBe(0);
    expect(r2.refreshed.length).toBe(1);
    expect(Object.keys(b.findings).length).toBe(1);
  });
});
