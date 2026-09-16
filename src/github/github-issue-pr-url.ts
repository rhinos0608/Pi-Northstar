// GitHub issues/PRs fetch-URL parser (M5): maps github.com issue/pull URLs
// onto the existing issues/pulls tool actions. Pure parser: no network, no
// tool calls. Reference parser semantics (owner/repo regexes, subpath and
// anchor rules) with normalized host handling: a leading `www.` is stripped
// before validation, so www.github.com routes exactly like github.com.
//
// v1 bounds: `conversation` subpaths and comment anchors route to the tool
// (top-level comments ride the entity body, capped); `files`/`commits`/
// `checks` subpaths decline so the page reader serves them (checks,
// changed-files, and commits rendering stays deferred).

export interface GithubIssuePrFetchUrl {
  owner: string;
  repo: string;
  kind: 'issue' | 'pull';
  number: number;
  subpath?: 'files' | 'commits' | 'checks' | 'conversation' | undefined;
  anchor?: string | undefined;
}

const PR_SUBPATHS: ReadonlySet<string> = new Set(['files', 'commits', 'checks', 'conversation']);

function validOwner(owner: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && !owner.includes('--');
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== '.' && repo !== '..';
}

/**
 * Parse a github.com issue/pull URL. Returns undefined for any non-matching
 * shape (reject-not-clamp: non-positive/non-integer numbers, bad owner/repo
 * characters, unknown PR subpaths, issues subpaths, and non-github hosts all
 * decline so the caller falls through to the page reader).
 */
export function parseGithubIssuePrFetchUrl(raw: string): GithubIssuePrFetchUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (host !== 'github.com') return undefined;
  const segments: string[] = [];
  for (const segment of parsed.pathname.split('/').filter(Boolean)) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  if (segments.length < 4) return undefined;
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, '');
  if (!validOwner(owner) || !validRepo(repo)) return undefined;
  const route = segments[2]!.toLowerCase();
  if (route !== 'pull' && route !== 'issues') return undefined;
  if (!/^\d+$/.test(segments[3]!)) return undefined;
  const number = Number.parseInt(segments[3]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  if (segments.length > 5) return undefined;
  const subpath = segments[4]?.toLowerCase();
  if (route === 'pull') {
    if (subpath !== undefined && !PR_SUBPATHS.has(subpath)) return undefined;
  } else if (subpath !== undefined) {
    return undefined;
  }
  const fragment = parsed.hash.slice(1);
  const anchorPattern = route === 'pull' ? /^(?:issuecomment-\d+|discussion_r\d+)$/i : /^issuecomment-\d+$/i;
  const anchor = anchorPattern.test(fragment) ? fragment : undefined;
  return {
    owner,
    repo,
    kind: route === 'pull' ? 'pull' : 'issue',
    number,
    ...(subpath !== undefined ? { subpath: subpath as GithubIssuePrFetchUrl['subpath'] } : {}),
    ...(anchor !== undefined ? { anchor } : {}),
  };
}
