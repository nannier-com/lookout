// The cursor the server keeps into a run's transcript, and the three ways it
// stops being valid. Two of them shorten the file and can be noticed after the
// fact; the third, pointing lookout at another project, cannot, and going on as
// if nothing had happened put one project's judges under another's name.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../src/config.js";
import { narrationPath, type NarrationLine } from "../src/report/narration.js";
import { forgetNarration, newNarration } from "../src/ui/narration.js";
import "./setup.js";
import type { ResolvedConfig } from "../src/types.js";

function project(name: string): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), `lookout-uinar-${name}-`));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const r = {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: name,
  } as ResolvedConfig;
  mkdirSync(evidenceDir(r), { recursive: true });
  return r;
}

function write(r: ResolvedConfig, texts: string[], append = false): void {
  const body =
    texts
      .map((t, i) =>
        JSON.stringify({
          at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          runId: "r",
          panel: "judge-text",
          call: `c${i}`,
          kind: "text",
          text: t,
        } satisfies NarrationLine),
      )
      .join("\n") + "\n";
  if (append) appendFileSync(narrationPath(r), body);
  else writeFileSync(narrationPath(r), body);
}

afterEach(() => forgetNarration());

describe("reading a run's transcript once", () => {
  test("new lines are sent, and asking again with nothing new says nothing", () => {
    forgetNarration();
    const r = project("a");
    write(r, ["one", "two"]);
    const first = newNarration(r);
    expect(first?.lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(newNarration(r)).toBeNull();
    write(r, ["three"], true);
    expect(newNarration(r)?.lines.map((l) => l.text)).toEqual(["three"]);
  });

  test("a line still being written is left for the next read", () => {
    forgetNarration();
    const r = project("b");
    write(r, ["whole"]);
    expect(newNarration(r)?.lines).toHaveLength(1);
    appendFileSync(narrationPath(r), '{"at":"2026');
    expect(newNarration(r)).toBeNull();
  });

  test("a run that replaces the file is a reset, not a gap", () => {
    forgetNarration();
    const r = project("c");
    write(r, ["a long first run with plenty of narration in it", "and more"]);
    newNarration(r);
    write(r, ["new"]);
    const frame = newNarration(r);
    expect(frame?.reset).toBe(true);
    expect(frame?.lines.map((l) => l.text)).toEqual(["new"]);
  });
});

describe("pointing lookout somewhere else", () => {
  test("the next frame clears the page rather than appending to it", () => {
    forgetNarration();
    const a = project("d");
    write(a, ["the first project"]);
    newNarration(a);
    // Settled on the first project: nothing further to say about it.
    expect(newNarration(a)).toBeNull();

    const b = project("e");
    write(b, ["the second project"]);
    forgetNarration();
    const frame = newNarration(b);
    expect(frame?.reset).toBe(true);
    expect(frame?.lines.map((l) => l.text)).toEqual(["the second project"]);
  });

  test("switching to a project nothing has ever judged still clears the page", () => {
    forgetNarration();
    const a = project("f");
    write(a, ["the first project"]);
    newNarration(a);

    // No narration file at all: the honest frame is an empty reset, and without
    // one the page goes on showing the last project's judges indefinitely.
    const b = project("g");
    forgetNarration();
    const frame = newNarration(b);
    expect(frame).toEqual({ reset: true, lines: [] });
    // And only once: there is nothing further to say until something is judged.
    expect(newNarration(b)).toBeNull();
  });

  test("a switch noticed by the path alone resets too", () => {
    forgetNarration();
    const a = project("h");
    write(a, ["first"]);
    newNarration(a);
    // No forgetNarration(): the reader is simply asked about another project,
    // which is what a stale caller does.
    const b = project("i");
    write(b, ["second"]);
    const frame = newNarration(b);
    expect(frame?.reset).toBe(true);
    expect(frame?.lines.map((l) => l.text)).toEqual(["second"]);
  });
});
