// The watcher's lifecycle: what `stopWatching` has to mean.
//
// `startWatching` subscribes to the project change, and the subscription is the
// part that used to survive. A stopped watcher that keeps its subscription is
// not stopped: the next `setCurrentProject` calls it, and it arms a fresh
// `fs.watch` and schedules a reaction that pumps a queue on a project the
// stopped watcher was never pointed at. Nothing in one `lookout ui` process
// notices, because it starts once and stops on the way out. The suite notices,
// because it is one process running every file: the subscription left behind by
// `test/ui-live.test.ts` fired on `test/ui-queue.test.ts`'s project changes and
// handed off an issue in the middle of somebody else's assertions, which is one
// run in two of a gate that has to mean something.
//
// So each of these is the same shape: stop, change project, and check that
// nothing moved -- against a control that changes project with the watcher
// still running, so "nothing moved" cannot pass by watching nothing at all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lookoutDir } from "../src/config.js";
import { setHandoff, type Handoff } from "../src/ui/queue-pump.js";
import { projectChangeListenerCount, session, setCurrentProject } from "../src/ui/session.js";
import { startWatching, stopWatching, watching } from "../src/ui/watch.js";
import { tmpProject } from "./tmp-project.js";
import type { ResolvedConfig } from "../src/types.js";

/** Past the watcher's coalescing window, and then some. */
const SETTLE_MS = 400;

let restore: Handoff;
let handed: string[];

beforeEach(() => {
  handed = [];
  restore = setHandoff((_r, issue) => {
    handed.push(issue);
    return Promise.resolve({ launched: true });
  });
  session.queue = [];
  session.queueProjectDir = null;
});

afterEach(() => {
  stopWatching();
  setHandoff(restore);
  session.queue = [];
  session.queueProjectDir = null;
});

/**
 * Point lookout at a fresh project and give the watcher time to react.
 *
 * The reaction is a timer and a detached promise, so there is nothing to await:
 * what a caller can do is wait longer than the coalescing window and then ask
 * what happened.
 */
async function switchProject(prefix: string): Promise<ResolvedConfig> {
  const next = tmpProject(prefix);
  setCurrentProject(next);
  await Bun.sleep(SETTLE_MS);
  return next;
}

describe("the watcher's lifecycle", () => {
  // The control. Everything below asserts that a stopped watcher does nothing,
  // and that assertion is worth nothing unless a running one does something.
  test("a running watcher follows the project it is pointed at", async () => {
    setCurrentProject(tmpProject("lookout-watch-first-"));
    startWatching();
    const next = await switchProject("lookout-watch-second-");
    expect(watching()).toEqual([lookoutDir(next)]);
    // The reaction pumps, and the pump claims the session's queue cache for
    // whatever project it ran against. This is the state the leak used to
    // overwrite in the middle of another file's test.
    expect(session.queueProjectDir).toBe(next.projectDir);
  });

  test("a stopped watcher arms nothing when the project changes", async () => {
    setCurrentProject(tmpProject("lookout-watch-first-"));
    startWatching();
    stopWatching();
    await switchProject("lookout-watch-second-");
    expect(watching()).toEqual([]);
  });

  test("a stopped watcher does not pump the queue of a project it never watched", async () => {
    const first = tmpProject("lookout-watch-first-");
    setCurrentProject(first);
    startWatching();
    stopWatching();
    await switchProject("lookout-watch-second-");
    expect(handed).toEqual([]);
    expect(session.queueProjectDir).toBeNull();
    expect(session.queue).toEqual([]);
  });

  // Starting twice used to leave two subscriptions where stopping once removed
  // neither, so a file that started the watcher in more than one test leaked one
  // per test.
  test("starting twice and stopping once leaves nothing behind", async () => {
    setCurrentProject(tmpProject("lookout-watch-first-"));
    startWatching();
    startWatching();
    stopWatching();
    await switchProject("lookout-watch-second-");
    expect(watching()).toEqual([]);
    expect(session.queueProjectDir).toBeNull();
  });

  // The direct statement of the invariant the suite's guard checks: whatever a
  // subscriber does, it must be possible to take it back off the list.
  test("stopping unsubscribes rather than only closing the watchers", () => {
    const before = projectChangeListenerCount();
    startWatching();
    expect(projectChangeListenerCount()).toBe(before + 1);
    stopWatching();
    expect(projectChangeListenerCount()).toBe(before);
  });

  // Start, stop, start again: the reaction the first run left in the air must
  // not be mistaken for the second run's own, which is why the guard is a
  // counter rather than a flag.
  test("a watcher started again is not the one that was stopped", async () => {
    setCurrentProject(tmpProject("lookout-watch-first-"));
    startWatching();
    stopWatching();
    startWatching();
    const next = await switchProject("lookout-watch-second-");
    expect(watching()).toEqual([lookoutDir(next)]);
    expect(projectChangeListenerCount()).toBe(1);
  });
});
