/**
 * The commit a fix landed in, as a link somebody can open.
 *
 * lookout already records which commit cleared an issue: `verify-fix` writes it
 * onto the finding, and the attempt log keeps what was reported. Until now that
 * was forty hex characters on a card, which is the right fact in the least
 * useful form. The thing a person wants at that moment is the diff.
 *
 * So the repository's own remote is read and turned into a web URL. Nothing is
 * fetched and no API is called: this is string work over `git remote`, done
 * once per project and cached, because a remote does not change while a page is
 * open and a subprocess per poll would be absurd.
 *
 * Hosts lookout knows get their exact URL shape. A host it does not know still
 * gets a link, built the way GitLab CE, Gitea, Forgejo and cgit all build it,
 * because `/commit/<sha>` is the near-universal convention and a link that
 * might 404 on an unusual self-hosted forge is worth more than no link at all.
 * The host is shown beside it either way, so nobody is guessing where they are
 * about to be sent.
 */
import { execFileAsync } from "../util.js";

export interface Forge {
  /** Which family the URL shape came from; "unknown" means the convention was assumed. */
  kind: "github" | "gitlab" | "bitbucket" | "azure" | "unknown";
  /** The host, shown so a person can see where a link goes before clicking it. */
  host: string;
  /** Web URL of the repository, no trailing slash. */
  repoUrl: string;
}

/**
 * A remote URL in any of the forms git accepts, as a web URL.
 *
 * Returns null for a remote nothing can be built from: a local path, a file://
 * clone, an empty string. A project cloned from a directory has no web home,
 * and inventing one would produce a link to nowhere.
 */
export function parseRemote(remote: string): Forge | null {
  const raw = remote.trim();
  if (!raw) return null;

  let host: string;
  let path: string;

  // scp-style: git@host:owner/repo.git, which is not a URL and cannot be parsed
  // as one. It is also the default GitHub and GitLab hand out, so it is the
  // form most remotes are actually written in.
  const scp = /^(?:([^@/]+)@)?([^/:]+):(.+)$/.exec(raw);
  if (scp && !raw.includes("://")) {
    host = scp[2]!;
    path = scp[3]!;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol === "file:" || !url.hostname) return null;
    host = url.hostname;
    path = url.pathname;
  }

  const clean = path.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
  if (!clean) return null;

  const kind: Forge["kind"] = /(^|\.)github\.com$/.test(host)
    ? "github"
    : /(^|\.)gitlab\./.test(host) || host === "gitlab.com"
      ? "gitlab"
      : /(^|\.)bitbucket\.org$/.test(host)
        ? "bitbucket"
        : /(^|\.)(dev\.azure\.com|visualstudio\.com)$/.test(host)
          ? "azure"
          : "unknown";

  return { kind, host, repoUrl: `https://${host}/${clean}` };
}

/** Where that commit is browsable, in whichever shape this host uses. */
export function commitUrl(forge: Forge, sha: string): string | null {
  const clean = sha.trim();
  // A short sha is fine; anything that is not hex is not a commit, and pasting
  // it into a URL would produce a link to a search page at best.
  if (!/^[0-9a-f]{7,40}$/i.test(clean)) return null;
  switch (forge.kind) {
    case "bitbucket":
      return `${forge.repoUrl}/commits/${clean}`;
    case "azure":
      return `${forge.repoUrl}/commit/${clean}`;
    default:
      return `${forge.repoUrl}/commit/${clean}`;
  }
}

/**
 * The remote to link against: `origin` when there is one, else whatever the
 * repository's first remote is, because a checkout with one differently-named
 * remote is still a checkout with a web home.
 */
export async function readRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd });
    const url = stdout.trim();
    if (url) return url;
  } catch {
    // No origin. Fall through and take the first remote there is.
  }
  try {
    const { stdout } = await execFileAsync("git", ["remote"], { cwd });
    const first = stdout.trim().split("\n")[0]?.trim();
    if (!first) return null;
    const { stdout: url } = await execFileAsync("git", ["remote", "get-url", first], { cwd });
    return url.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The project's forge, read once and kept.
 *
 * Keyed by directory rather than by process: the ui server serves one project
 * at a time but can be repointed, and a memo that ignored that would show one
 * project's repository on another one's cards. `null` is cached too, because a
 * checkout with no remote should not re-run git on every poll to be told so
 * again.
 */
const cache = new Map<string, Forge | null>();

export async function forgeOf(cwd: string): Promise<Forge | null> {
  const hit = cache.get(cwd);
  if (hit !== undefined) return hit;
  const remote = await readRemote(cwd);
  const forge = remote ? parseRemote(remote) : null;
  cache.set(cwd, forge);
  return forge;
}

/** Drop the memo, for tests and for a ui server that has been repointed. */
export function forgetForges(): void {
  cache.clear();
}
