// Noticing that a server is serving a build older than the source.
//
// What this file guards: the check must be silent unless it has evidence on
// both sides. A server that sends no Last-Modified, a source walk that gave up,
// a gap inside timestamp granularity, and a target that is down all mean "no
// opinion", because a false stale warning teaches the operator to ignore the
// real one. The one case it must not miss is the expensive one: source edited
// after the build that is being photographed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestSourceMtime, staleReason, staleTargets, STALE_SLACK_MS } from "../src/freshness.js";
import type { TargetStatus } from "../src/targets.js";

/** Seconds since the epoch for a file written at a chosen moment. */
function write(dir: string, rel: string, atMs: number): string {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const seconds = atMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

function tree(): string {
  return mkdtempSync(join(tmpdir(), "lookout-freshness-"));
}

function status(over: Partial<TargetStatus> = {}): TargetStatus {
  return {
    name: "web",
    url: "http://localhost:3000",
    routes: 3,
    up: true,
    status: 200,
    servedAt: null,
    ...over,
  };
}

const HOUR = 3_600_000;

describe("newestSourceMtime", () => {
  test("answers with the newest source file it can see", () => {
    const dir = tree();
    try {
      const old = Date.now() - 4 * HOUR;
      const recent = Date.now() - HOUR;
      write(dir, "src/a.ts", old);
      write(dir, "src/nested/deep/b.tsx", recent);
      write(dir, "styles/c.css", old);
      expect(newestSourceMtime(dir)).toBeCloseTo(recent, -3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores build output, dependencies and dot-directories", () => {
    const dir = tree();
    try {
      const source = Date.now() - 4 * HOUR;
      const newer = Date.now();
      write(dir, "src/a.ts", source);
      // Each of these is newer than the real source and must not count: a
      // rebuilt bundle or a fresh install would otherwise read as an edit.
      write(dir, "node_modules/pkg/index.js", newer);
      write(dir, "dist/bundle.js", newer);
      write(dir, "build/out.css", newer);
      write(dir, "coverage/lcov.html", newer);
      write(dir, ".next/static/chunk.js", newer);
      write(dir, ".git/hooks/x.js", newer);
      expect(newestSourceMtime(dir)).toBeCloseTo(source, -3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores files that are not source, prose included", () => {
    const dir = tree();
    try {
      const source = Date.now() - 4 * HOUR;
      const newer = Date.now();
      write(dir, "src/a.ts", source);
      // A changelog written by a release, a lockfile written by an install and
      // a screenshot are all newer than the code without the code changing.
      write(dir, "CHANGELOG.md", newer);
      write(dir, "package-lock.json", newer);
      write(dir, "shot.png", newer);
      write(dir, "notes.txt", newer);
      expect(newestSourceMtime(dir)).toBeCloseTo(source, -3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("declines rather than guesses when a cap trips", () => {
    const dir = tree();
    try {
      write(dir, "src/a.ts", Date.now());
      write(dir, "src/b.ts", Date.now());
      write(dir, "src/c.ts", Date.now());
      expect(newestSourceMtime(dir, { maxEntries: 1 })).toBeNull();
      expect(newestSourceMtime(dir, { maxMs: -1 })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("declines on an unreadable directory and on a tree with no source", () => {
    const dir = tree();
    try {
      write(dir, "README.md", Date.now());
      expect(newestSourceMtime(join(dir, "nope"))).toBeNull();
      expect(newestSourceMtime(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("staleTargets", () => {
  const now = Date.now();

  test("says nothing when either side has no evidence", () => {
    // The server volunteered no Last-Modified: the hot-reload case.
    expect(staleTargets([status({ servedAt: null })], now)).toEqual([]);
    // The walk gave up, so there is nothing to compare against.
    expect(staleTargets([status({ servedAt: now - HOUR })], null)).toEqual([]);
  });

  test("says nothing about a target that is down", () => {
    const down = status({ servedAt: now - HOUR, up: false, status: null });
    expect(staleTargets([down], now)).toEqual([]);
  });

  test("says nothing when the build is newer than the source, or inside the slack", () => {
    expect(staleTargets([status({ servedAt: now })], now - HOUR)).toEqual([]);
    expect(staleTargets([status({ servedAt: now - STALE_SLACK_MS / 2 })], now)).toEqual([]);
  });

  test("catches an edit made after the build, which is the case worth catching", () => {
    const served = now - 47 * 60_000;
    const [stale, ...rest] = staleTargets([status({ servedAt: served })], now);
    expect(rest).toEqual([]);
    expect(stale?.name).toBe("web");
    expect(stale?.servedAt).toBe(served);
    expect(stale?.behindMinutes).toBe(47);
  });

  test("reports the widest gap first", () => {
    const targets = [
      status({ name: "near", servedAt: now - 10 * 60_000 }),
      status({ name: "far", servedAt: now - 90 * 60_000 }),
    ];
    expect(staleTargets(targets, now).map((s) => s.name)).toEqual(["far", "near"]);
  });
});

describe("staleReason", () => {
  const now = Date.now();

  test("is null when nothing is stale", () => {
    expect(staleReason([status({ servedAt: null })], now)).toBeNull();
  });

  test("names the target, the gap, and what the operator has to do", () => {
    const reason = staleReason([status({ servedAt: now - 47 * 60_000 })], now);
    expect(reason).toContain("web: http://localhost:3000");
    expect(reason).toContain("47 minute(s) older");
    expect(reason).toContain("rebuild and restart");
    // lookout never does it for them, and the wording must not imply it will.
    expect(reason).not.toContain("restarting");
  });
});
