// Turning a git remote into a link somebody can open. Pure string work, so the
// tests are the remote forms git actually hands out rather than a fixture repo.
import { describe, expect, test } from "bun:test";
import { commitUrl, parseRemote } from "../src/report/forge.js";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("parseRemote", () => {
  test("reads the scp form every forge hands out by default", () => {
    const f = parseRemote("git@github.com:nannier-com/lookout.git")!;
    expect(f.kind).toBe("github");
    expect(f.host).toBe("github.com");
    expect(f.repoUrl).toBe("https://github.com/nannier-com/lookout");
  });

  test("reads https remotes, with and without the .git suffix", () => {
    expect(parseRemote("https://github.com/o/r.git")!.repoUrl).toBe("https://github.com/o/r");
    expect(parseRemote("https://github.com/o/r")!.repoUrl).toBe("https://github.com/o/r");
  });

  test("keeps a GitLab subgroup path, which is most of what GitLab paths are", () => {
    const f = parseRemote("ssh://git@gitlab.com/group/sub/repo.git")!;
    expect(f.kind).toBe("gitlab");
    expect(f.repoUrl).toBe("https://gitlab.com/group/sub/repo");
  });

  test("names self-hosted hosts it does not recognise, rather than refusing them", () => {
    const f = parseRemote("git@git.internal.example:team/app.git")!;
    expect(f.kind).toBe("unknown");
    expect(f.host).toBe("git.internal.example");
    expect(f.repoUrl).toBe("https://git.internal.example/team/app");
  });

  test("recognises bitbucket, which spells its commit path differently", () => {
    expect(parseRemote("git@bitbucket.org:o/r.git")!.kind).toBe("bitbucket");
  });

  test("has nothing to offer for a clone with no web home", () => {
    expect(parseRemote("/srv/git/repo.git")).toBeNull();
    expect(parseRemote("file:///srv/git/repo.git")).toBeNull();
    expect(parseRemote("")).toBeNull();
  });
});

describe("commitUrl", () => {
  test("builds the shape each host uses", () => {
    expect(commitUrl(parseRemote("git@github.com:o/r.git")!, SHA)).toBe(
      `https://github.com/o/r/commit/${SHA}`,
    );
    expect(commitUrl(parseRemote("git@bitbucket.org:o/r.git")!, SHA)).toBe(
      `https://bitbucket.org/o/r/commits/${SHA}`,
    );
  });

  test("links a short sha, which is what people paste", () => {
    expect(commitUrl(parseRemote("https://gitlab.com/o/r")!, "a1b2c3d")).toBe(
      "https://gitlab.com/o/r/commit/a1b2c3d",
    );
  });

  test("refuses anything that is not a commit", () => {
    const f = parseRemote("git@github.com:o/r.git")!;
    // A branch name in a commit URL lands on a page that is not the diff, or on
    // nothing at all, and it looks like a link that works until it is clicked.
    expect(commitUrl(f, "main")).toBeNull();
    expect(commitUrl(f, "")).toBeNull();
    expect(commitUrl(f, "not a sha")).toBeNull();
  });
});
