// The card links each issue's document, and the server hands it over. That is a
// seam: the URL is spelled in the client module and matched in the server one,
// and nothing but this notices when one moves and the other does not.
//
// The resolver is tested rather than the streaming, because which URLs resolve
// to a file is the whole of the behaviour: an id that is not six digits, a name
// that is not the document, and a path that tries to climb out of the folder
// all have to come back with nothing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueDocFile } from "../src/ui/document.js";
import { ISSUE_ARCHIVE_DIR, ISSUE_DOC_FILE } from "../src/issues/paths.js";
import { clientDir } from "../src/ui/assets.js";
import { tmpProject } from "./tmp-project.js";

/** A project with one issue's folder written, the way a backlog save leaves it. */
function withIssue(id: string, archived = false): ReturnType<typeof tmpProject> {
  const r = tmpProject("lookout-issue-doc-");
  const dir = archived
    ? join(r.projectDir, ".lookout", "issues", ISSUE_ARCHIVE_DIR, id)
    : join(r.projectDir, ".lookout", "issues", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ISSUE_DOC_FILE), `# ${id}\n`);
  return r;
}

describe("serving an issue's document", () => {
  test("resolves the document an issue folder holds", () => {
    const r = withIssue("418203");
    const file = issueDocFile(r, `/issue/418203/${ISSUE_DOC_FILE}`);
    expect(file).not.toBeNull();
    expect(readFileSync(file!, "utf8")).toBe("# 418203\n");
  });

  test("follows an issue that has been filed away", () => {
    // The folder moves into `archive/` when an issue is filed, and its document
    // moves with it. A link that only ever looked beside the open issues would
    // go dead the moment somebody archived one.
    const r = withIssue("552140", true);
    expect(issueDocFile(r, `/issue/552140/${ISSUE_DOC_FILE}`)).not.toBeNull();
  });

  test("answers with nothing when the folder was never written", () => {
    const r = tmpProject("lookout-issue-doc-");
    expect(issueDocFile(r, `/issue/418203/${ISSUE_DOC_FILE}`)).toBeNull();
  });

  test("serves that one file name and no other", () => {
    const r = withIssue("418203");
    const dir = join(r.projectDir, ".lookout", "issues", "418203");
    writeFileSync(join(dir, "Issue.json"), "{}");
    expect(issueDocFile(r, "/issue/418203/Issue.json")).toBeNull();
    expect(issueDocFile(r, "/issue/418203/issue.md")).toBeNull();
  });

  test("no URL reaches outside an issue folder", () => {
    const r = withIssue("418203");
    writeFileSync(join(r.projectDir, ".lookout", "backlog.json"), "{}");
    for (const bad of [
      "/issue/../backlog.json",
      `/issue/../../${ISSUE_DOC_FILE}`,
      `/issue/41820/${ISSUE_DOC_FILE}`,
      `/issue/4182031/${ISSUE_DOC_FILE}`,
      `/issue/418203/../../backlog.json`,
      `/issue/%2e%2e/${ISSUE_DOC_FILE}`,
      `/issue/418203/img/../${ISSUE_DOC_FILE}`,
    ]) {
      expect(issueDocFile(r, bad), `${bad} resolved to a file`).toBeNull();
    }
  });

  test("the URL the card writes is one the server answers", () => {
    // Read out of the client's source, because that is the copy the browser
    // runs. A link built one way and matched another is a 404 nobody sees until
    // they click it, and no other gate in this repo would notice.
    const source = readFileSync(join(clientDir(), "board.ts"), "utf8");
    const built = /href="(\/issue\/[^"]*)"/.exec(source);
    expect(built, "the card no longer links an issue document").not.toBeNull();
    const href = built![1]!
      // The card interpolates the id; every id is six digits.
      .replace(/'\s*\+\s*enc\(b\.id\)\s*\+\s*'/, "418203");
    expect(href, "the card builds the href some other way now").not.toContain("+");

    const r = withIssue("418203");
    expect(issueDocFile(r, href), `the server does not answer ${href}`).not.toBeNull();
  });
});
