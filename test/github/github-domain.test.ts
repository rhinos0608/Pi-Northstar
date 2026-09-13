import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callGithubTool, parseGithubRetryAfter } from '../../src/github/github-domain.js';
import { SocialError } from '../../src/social/social-contract.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response;

async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

async function expectGithubError(code: string, fn: () => Promise<unknown>): Promise<SocialError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}), but nothing threw`);
}

function repoRow() {
  return {
    id: 1,
    name: 'kit',
    full_name: 'octo/kit',
    description: 'demo repo',
    html_url: 'https://github.com/octo/kit',
    stargazers_count: 42,
    forks_count: 7,
    language: 'TypeScript',
    default_branch: 'main',
    node_id: 'RAW-NODE-ID',
  };
}

// ── Happy paths ──

test('repo normalizes without raw passthrough', async () => {
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/octo/kit')) return jsonResponse(repoRow());
    if (url.endsWith('/repos/octo/kit/readme')) {
      return jsonResponse({ content: Buffer.from('hello readme').toString('base64'), encoding: 'base64' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, () => callGithubTool({ action: 'repo', owner: 'octo', repo: 'kit' }, { env: {} }));
  const details = result.details as Record<string, unknown>;
  const entities = details.entities as Array<Record<string, unknown>>;
  assert.equal(entities.length, 1);
  assert.equal(entities[0]?.kind, 'repo');
  assert.equal(entities[0]?.full_name, 'octo/kit');
  assert.equal(entities[0]?.stars, 42);
  assert.equal(entities[0]?.readme, 'hello readme');
  const text = JSON.stringify(details);
  for (const raw of ['stargazers_count', 'forks_count', 'node_id', 'backend_text']) {
    assert.doesNotMatch(text, new RegExp(raw), `raw field leaked: ${raw}`);
  }
  const northstar = (details.northstar ?? {}) as { status?: string; data?: { kind?: string } };
  assert.equal(northstar.data?.kind, 'entities');
});

test('file decodes base64 content', async () => {
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/contents/src/a.ts')) {
      return jsonResponse({
        type: 'file',
        path: 'src/a.ts',
        html_url: 'https://github.com/octo/kit/blob/main/src/a.ts',
        size: 11,
        content: Buffer.from('hello world').toString('base64'),
        encoding: 'base64',
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, () => callGithubTool({ action: 'file', owner: 'octo', repo: 'kit', path: 'src/a.ts' }, { env: {} }));
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.kind, 'file');
  assert.equal(entities[0]?.content, 'hello world');
  assert.equal(entities[0]?.encoding, 'utf8');
});

test('multi-file paths fan out; 11 paths reject before fetch', async () => {
  let calls = 0;
  const result = await withFetch(async () => {
    calls++;
    return jsonResponse({ type: 'file', path: 'x', content: Buffer.from('c').toString('base64'), encoding: 'base64' });
  }, () => callGithubTool({ action: 'file', owner: 'o', repo: 'r', paths: ['a.ts', 'b.ts'] }, { env: {} }));
  assert.equal(((result.details as Record<string, unknown>).entities as unknown[]).length, 2);
  assert.equal(calls, 2);

  let fetched = false;
  await expectGithubError('invalid_request', () => withFetch(async () => {
    fetched = true;
    return jsonResponse({});
  }, () => callGithubTool(
    { action: 'file', owner: 'o', repo: 'r', paths: Array.from({ length: 11 }, (_, i) => `f${i}.ts`) },
    { env: {} },
  )));
  assert.equal(fetched, false, 'cap reject must happen before any fetch');
});

test('issues list and get normalize', async () => {
  const issue = {
    id: 9, number: 12, title: 'bug', state: 'open',
    user: { login: 'octo' }, html_url: 'https://github.com/o/r/issues/12',
    body: 'details', labels: [{ name: 'bug' }], created_at: '2024-01-01T00:00:00Z',
  };
  const list = await withFetch(async (input) => {
    assert.match(String(input), /\/issues\?/);
    return jsonResponse([issue]);
  }, () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r', state: 'open' }, { env: {} }));
  const listEntities = (list.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(listEntities[0]?.kind, 'issue');
  assert.equal(listEntities[0]?.number, 12);
  assert.deepEqual(listEntities[0]?.labels, ['bug']);

  const single = await withFetch(async (input) => {
    assert.match(String(input), /\/issues\/12$/);
    return jsonResponse(issue);
  }, () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r', number: 12 }, { env: {} }));
  assert.equal(((single.details as Record<string, unknown>).entities as Array<Record<string, unknown>>).length, 1);
});

test('pulls list, get, and files normalize', async () => {
  const pull = {
    id: 5, number: 3, title: 'feat', state: 'open',
    user: { login: 'dev' }, html_url: 'https://github.com/o/r/pull/3', body: 'b', labels: [],
  };
  const list = await withFetch(async () => jsonResponse([pull]),
    () => callGithubTool({ action: 'pulls', owner: 'o', repo: 'r' }, { env: {} }));
  assert.equal(((list.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.kind, 'pull');

  const single = await withFetch(async (input) => {
    assert.match(String(input), /\/pulls\/3$/);
    return jsonResponse(pull);
  }, () => callGithubTool({ action: 'pulls', owner: 'o', repo: 'r', number: 3 }, { env: {} }));
  assert.equal(((single.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.kind, 'pull');

  const files = await withFetch(async (input) => {
    assert.match(String(input), /\/pulls\/3\/files$/);
    return jsonResponse([{ filename: 'src/a.ts', patch: '@@ diff @@' }]);
  }, () => callGithubTool({ action: 'pulls', owner: 'o', repo: 'r', number: 3, files: true }, { env: {} }));
  const fileEntities = (files.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(fileEntities[0]?.kind, 'file');
  assert.equal(fileEntities[0]?.path, 'src/a.ts');
});

test('releases list, latest, and tag normalize', async () => {
  const release = {
    id: 2, tag_name: 'v1.0.0', name: 'one', published_at: '2024-05-01T00:00:00Z',
    html_url: 'https://github.com/o/r/releases/tag/v1.0.0', body: 'notes',
  };
  const list = await withFetch(async () => jsonResponse([release]),
    () => callGithubTool({ action: 'releases', owner: 'o', repo: 'r' }, { env: {} }));
  assert.equal(((list.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.kind, 'release');

  const latest = await withFetch(async (input) => {
    assert.match(String(input), /\/releases\/latest$/);
    return jsonResponse(release);
  }, () => callGithubTool({ action: 'releases', owner: 'o', repo: 'r', latest: true }, { env: {} }));
  assert.equal(((latest.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.tag, 'v1.0.0');

  const byTag = await withFetch(async (input) => {
    assert.match(String(input), /\/releases\/tags\/v1\.0\.0$/);
    return jsonResponse(release);
  }, () => callGithubTool({ action: 'releases', owner: 'o', repo: 'r', tag: 'v1.0.0' }, { env: {} }));
  assert.equal(((byTag.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.tag, 'v1.0.0');
});

test('commits list and get normalize', async () => {
  const commit = {
    sha: 'abc1234def',
    html_url: 'https://github.com/o/r/commit/abc1234def',
    commit: { message: 'fix it', author: { name: 'dev', date: '2024-02-02T00:00:00Z' } },
    author: { login: 'dev' },
  };
  const list = await withFetch(async (input) => {
    assert.match(String(input), /since=2024/);
    return jsonResponse([commit]);
  }, () => callGithubTool({ action: 'commits', owner: 'o', repo: 'r', since: '2024-01-01T00:00:00Z' }, { env: {} }));
  const listEntities = (list.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(listEntities[0]?.kind, 'commit');
  assert.equal(listEntities[0]?.sha, 'abc1234def');

  const single = await withFetch(async (input) => {
    assert.match(String(input), /\/commits\/abc1234$/);
    return jsonResponse(commit);
  }, () => callGithubTool({ action: 'commits', owner: 'o', repo: 'r', sha: 'abc1234' }, { env: {} }));
  assert.equal(((single.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.sha, 'abc1234def');
});

test('workflows list and get normalize', async () => {
  const workflow = {
    id: 161335, name: 'CI', path: '.github/workflows/ci.yml', state: 'active',
    html_url: 'https://github.com/o/r/blob/main/.github/workflows/ci.yml',
    badge_url: 'https://github.com/o/r/workflows/CI/badge.svg',
  };
  const list = await withFetch(async (input) => {
    assert.match(String(input), /\/actions\/workflows\?/);
    return jsonResponse({ total_count: 1, workflows: [workflow] });
  }, () => callGithubTool({ action: 'workflows', owner: 'o', repo: 'r' }, { env: {} }));
  const listEntities = (list.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(listEntities[0]?.kind, 'workflow');
  assert.equal(listEntities[0]?.workflow_id, 161335);
  assert.equal(listEntities[0]?.name, 'CI');

  const single = await withFetch(async (input) => {
    assert.match(String(input), /\/actions\/workflows\/ci\.yml$/);
    return jsonResponse(workflow);
  }, () => callGithubTool({ action: 'workflows', owner: 'o', repo: 'r', workflow: 'ci.yml' }, { env: {} }));
  assert.equal(((single.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.path, '.github/workflows/ci.yml');
});

test('runs list scoped to workflow, get single run, and jobs normalize', async () => {
  const run = {
    id: 30433642, run_number: 562, name: 'Build', status: 'completed', conclusion: 'success',
    head_branch: 'main', head_sha: 'abc1234', event: 'push',
    html_url: 'https://github.com/o/r/actions/runs/30433642', created_at: '2024-01-01T00:00:00Z',
    actor: { login: 'octo' },
  };
  const list = await withFetch(async (input) => {
    assert.match(String(input), /\/actions\/workflows\/ci\.yml\/runs\?/);
    assert.match(String(input), /branch=main/);
    assert.match(String(input), /status=success/);
    assert.match(String(input), /actor=octo/);
    return jsonResponse({ total_count: 1, workflow_runs: [run] });
  }, () => callGithubTool({
    action: 'runs', owner: 'o', repo: 'r', workflow: 'ci.yml', branch: 'main', status: 'success', author: 'octo',
  }, { env: {} }));
  const listEntities = (list.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(listEntities[0]?.kind, 'workflow_run');
  assert.equal(listEntities[0]?.run_id, 30433642);
  assert.equal(listEntities[0]?.actor, 'octo');

  const single = await withFetch(async (input) => {
    assert.match(String(input), /\/actions\/runs\/30433642$/);
    return jsonResponse(run);
  }, () => callGithubTool({ action: 'runs', owner: 'o', repo: 'r', number: 30433642 }, { env: {} }));
  assert.equal(((single.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.run_number, 562);

  const jobs = await withFetch(async (input) => {
    assert.match(String(input), /\/actions\/runs\/30433642\/jobs\?/);
    assert.match(String(input), /per_page=20/);
    assert.match(String(input), /page=1/);
    return jsonResponse({
      total_count: 1,
      jobs: [{
        id: 399444496, name: 'build', status: 'completed', conclusion: 'success',
        started_at: '2024-01-01T00:00:00Z', completed_at: '2024-01-01T00:05:00Z',
        html_url: 'https://github.com/o/r/runs/1/jobs/399444496',
      }],
    });
  }, () => callGithubTool({ action: 'runs', owner: 'o', repo: 'r', number: 30433642, jobs: true }, { env: {} }));
  const jobEntities = (jobs.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(jobEntities[0]?.kind, 'workflow_job');
  assert.equal(jobEntities[0]?.job_id, 399444496);
  assert.equal(jobEntities[0]?.run_id, 30433642);
});

test('runs and workflows validation: bad status, jobs misuse, jobs without number', async () => {
  await expectGithubError('invalid_request', () => callGithubTool({ action: 'runs', owner: 'o', repo: 'r', status: 'bogus' }, { env: {} }));
  await expectGithubError('invalid_request', () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r', jobs: true }, { env: {} }));
  await expectGithubError('invalid_request', () => callGithubTool({ action: 'runs', owner: 'o', repo: 'r', jobs: true }, { env: {} }));
});

test('search and search_repos normalize; query is required', async () => {
  const code = await withFetch(async (input) => {
    assert.match(String(input), /\/search\/code\?/);
    return jsonResponse({ items: [{ name: 'a.ts', path: 'src/a.ts', html_url: 'https://github.com/o/r/blob/main/src/a.ts', repository: { full_name: 'o/r' } }] });
  }, () => callGithubTool({ action: 'search', query: 'repo:o/r a' }, { env: {} }));
  const codeEntities = (code.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(codeEntities[0]?.kind, 'search_result');
  assert.equal(codeEntities[0]?.repository, 'o/r');

  const repos = await withFetch(async (input) => {
    assert.match(String(input), /\/search\/repositories\?/);
    return jsonResponse({ items: [repoRow()] });
  }, () => callGithubTool({ action: 'search_repos', query: 'kit' }, { env: {} }));
  assert.equal(((repos.details as Record<string, unknown>).entities as Array<Record<string, unknown>>)[0]?.kind, 'repo');

  await expectGithubError('invalid_request', () => callGithubTool({ action: 'search' }, { env: {} }));
  await expectGithubError('invalid_request', () => callGithubTool({ action: 'search_repos', query: '   ' }, { env: {} }));
});

test('tree normalizes entries', async () => {
  const result = await withFetch(async () => jsonResponse({
    sha: 'abc1234', truncated: false,
    tree: [{ path: 'src', type: 'tree', sha: 'abc1234' }, { path: 'src/a.ts', type: 'blob', sha: 'def5678' }],
  }), () => callGithubTool({ action: 'tree', owner: 'o', repo: 'r', ref: 'main' }, { env: {} }));
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.kind, 'tree');
  assert.equal((entities[0]?.entries as unknown[]).length, 2);
});

test('issues list excludes pull_request rows; single PR number rejects', async () => {
  const issue = {
    id: 9, number: 12, title: 'bug', state: 'open',
    user: { login: 'octo' }, html_url: 'https://github.com/o/r/issues/12',
    body: 'details', labels: [{ name: 'bug' }], created_at: '2024-01-01T00:00:00Z',
  };
  const prRow = {
    id: 10, number: 13, title: 'feat', state: 'open',
    user: { login: 'dev' }, html_url: 'https://github.com/o/r/pull/13',
    body: 'pr body', labels: [], created_at: '2024-01-02T00:00:00Z',
    pull_request: {},
  };
  const list = await withFetch(async () => jsonResponse([issue, prRow]),
    () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r', state: 'open' }, { env: {} }));
  const details = list.details as {
    entities: Array<Record<string, unknown>>;
    pagination: { returned: number };
    partial: boolean; warnings: string[];
  };
  assert.equal(details.entities.length, 1);
  assert.equal(details.entities[0]?.kind, 'issue');
  assert.equal(details.entities[0]?.number, 12);
  assert.equal(details.pagination.returned, 1);
  assert.equal(details.partial, true);
  assert.match(details.warnings.join('; '), /1 pull request excluded from issues list/);

  const err = await expectGithubError('invalid_request', () => withFetch(async (input) => {
    assert.match(String(input), /\/issues\/13$/);
    return jsonResponse(prRow);
  }, () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r', number: 13 }, { env: {} })));
  assert.match(err.message, /number 13 is a pull request, use pulls action/);
});

// ── Validation before fetch ──

test('legacy actions reject as unsupported_action with no fetch', async () => {
  for (const action of ['list_dir', 'code_search']) {
    let fetched = false;
    await expectGithubError('unsupported_action', () => withFetch(async () => {
      fetched = true;
      return jsonResponse({});
    }, () => callGithubTool({ action, owner: 'o', repo: 'r', path: 'x' }, { env: {} })));
    assert.equal(fetched, false, `${action} must reject before fetch`);
  }
});

test('traversal rejects before fetch', async () => {
  let fetched = false;
  await expectGithubError('invalid_request', () => withFetch(async () => {
    fetched = true;
    return jsonResponse({});
  }, () => callGithubTool({ action: 'file', owner: 'o', repo: 'r', path: '../secret' }, { env: {} })));
  assert.equal(fetched, false, 'no fetch may happen for traversal paths');
});

test('crafted release tags reject before fetch', async () => {
  for (const tag of ['../../tags', 'a%2Fb', 'a\\b', 'has space', 'a:b', '-v1']) {
    let fetched = false;
    await expectGithubError('invalid_request', () => withFetch(async () => {
      fetched = true;
      return jsonResponse({});
    }, () => callGithubTool({ action: 'releases', owner: 'o', repo: 'r', tag }, { env: {} })));
    assert.equal(fetched, false, `invalid tag must reject before fetch: ${tag}`);
  }
});

test('search perPage 51+ and trending 26 reject before fetch', async () => {
  for (const args of [
    { action: 'search', query: 'q', perPage: 51 },
    { action: 'search_repos', query: 'q', limit: 51 },
    { action: 'trending', limit: 26 },
    { action: 'issues', owner: 'o', repo: 'r', limit: 51 },
  ]) {
    let fetched = false;
    await expectGithubError('invalid_request', () => withFetch(async () => {
      fetched = true;
      return jsonResponse({});
    }, () => callGithubTool(args, { env: {} })));
    assert.equal(fetched, false, `cap reject must precede fetch for ${JSON.stringify(args)}`);
  }
});

// ── HTTP error mapping without URL/body echo ──

test('non-ok responses map cleanly with no URL or body echo', async () => {
  const cases: Array<{ status: number; code: string }> = [
    { status: 401, code: 'authentication_required' },
    { status: 403, code: 'rate_limited' },
    { status: 429, code: 'rate_limited' },
    { status: 404, code: 'not_found' },
    { status: 500, code: 'upstream_error' },
  ];
  for (const { status, code } of cases) {
    const err = await expectGithubError(code, () => withFetch(async () => (
      new Response('SECRET-BODY-MARKER', { status })
    ), () => callGithubTool({ action: 'repo', owner: 'octo', repo: 'kit' }, { env: {} })));
    assert.doesNotMatch(err.message, /api\.github\.com/, `status ${status} must not echo the URL`);
    assert.doesNotMatch(err.message, /SECRET-BODY-MARKER/, `status ${status} must not echo the body`);
    assert.doesNotMatch(err.message, /octo/, `status ${status} must not echo selectors`);
  }
});

test('429 Retry-After seconds surface on cause without URL echo', async () => {
  const err = await expectGithubError('rate_limited', () => withFetch(async () => (
    new Response('SECRET-BODY-MARKER', { status: 429, headers: { 'retry-after': '45' } })
  ), () => callGithubTool({ action: 'repo', owner: 'octo', repo: 'kit' }, { env: {} })));
  assert.deepEqual((err.cause as Record<string, unknown>), { retryAfter: 45 });
  assert.doesNotMatch(err.message, /api\.github\.com/);
  assert.doesNotMatch(err.message, /SECRET-BODY-MARKER/);
  assert.doesNotMatch(JSON.stringify(err.cause), /api\.github\.com/);
});

test('Retry-After clamps, parses HTTP-dates, and ignores absent/invalid', async () => {
  assert.equal(parseGithubRetryAfter(null), undefined);
  assert.equal(parseGithubRetryAfter('not-a-date'), undefined);
  assert.equal(parseGithubRetryAfter(''), undefined);
  assert.equal(parseGithubRetryAfter('0'), 1);
  assert.equal(parseGithubRetryAfter('9999'), 300);
  const future = new Date(Date.now() + 60_000).toUTCString();
  const parsed = parseGithubRetryAfter(future);
  assert.ok(parsed !== undefined && parsed >= 55 && parsed <= 65, `HTTP-date parses near 60, got ${parsed}`);

  const absent = await expectGithubError('rate_limited', () => withFetch(async () => (
    new Response('x', { status: 429 })
  ), () => callGithubTool({ action: 'repo', owner: 'octo', repo: 'kit' }, { env: {} })));
  assert.equal(absent.cause, undefined);

  const invalid = await expectGithubError('rate_limited', () => withFetch(async () => (
    new Response('x', { status: 403, headers: { 'retry-after': 'garbage' } })
  ), () => callGithubTool({ action: 'repo', owner: 'octo', repo: 'kit' }, { env: {} })));
  assert.equal(invalid.cause, undefined);
});

// ── Auth ──

test('GITHUB_TOKEN wins, GH_TOKEN falls back, anonymous sends no secret', async () => {
  const seen: Array<Record<string, string>> = [];
  const mock: FetchMock = async (_input, init) => {
    void _input;
    seen.push({ ...(init?.headers as Record<string, string>) });
    return jsonResponse(repoRow());
  };
  await withFetch(mock, () => callGithubTool(
    { action: 'repo', owner: 'o', repo: 'r' },
    { env: { GITHUB_TOKEN: 'tok-a', GH_TOKEN: 'tok-b' } },
  ));
  assert.equal(seen[0]?.Authorization, 'Bearer tok-a');

  seen.length = 0;
  await withFetch(mock, () => callGithubTool(
    { action: 'repo', owner: 'o', repo: 'r', includeReadme: false },
    { env: { GH_TOKEN: 'tok-gh' } },
  ));
  assert.equal(seen[0]?.Authorization, 'Bearer tok-gh');

  seen.length = 0;
  await withFetch(mock, () => callGithubTool(
    { action: 'repo', owner: 'o', repo: 'r', includeReadme: false },
    { env: {} },
  ));
  assert.equal(seen[0]?.Authorization, undefined);
});

// ── Pagination cursors ──

test('cursor round-trips page state and pins action+owner/repo+limit', async () => {
  const requested: string[] = [];
  const mock: FetchMock = async (input) => {
    requested.push(String(input));
    const page = /[?&]page=2(?:&|$)/.test(String(input)) ? 2 : 1;
    assert.match(String(input), /per_page=20/);
    if (page === 1) {
      return jsonResponse([{ id: 1, number: 1, title: 'a', state: 'open' }], 200, {
        Link: '<https://api.github.com/repos/o/r/issues?per_page=20&page=2>; rel="next"',
      });
    }
    return jsonResponse([{ id: 2, number: 2, title: 'b', state: 'open' }]);
  };
  const first = await withFetch(mock, () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r' }, { env: {} }));
  const firstDetails = first.details as {
    pagination: { supported: boolean; hasMore: boolean; nextCursor?: string };
    northstar: { pagination: { hasMore: boolean; nextCursor?: string } };
  };
  assert.equal(firstDetails.pagination.hasMore, true);
  const cursor = firstDetails.pagination.nextCursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0);
  assert.equal(firstDetails.northstar.pagination.nextCursor, cursor);

  requested.length = 0;
  const second = await withFetch(mock, () => callGithubTool(
    { action: 'issues', owner: 'o', repo: 'r', cursor }, { env: {} },
  ));
  assert.match(requested[0] ?? '', /page=2/);
  const secondEntities = (second.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(secondEntities[0]?.number, 2);

  // Limit change breaks the pin: reject before fetch.
  let fetched = false;
  await expectGithubError('cursor_invalid', () => withFetch(async () => {
    fetched = true;
    return jsonResponse([]);
  }, () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r', limit: 10, cursor }, { env: {} })));
  assert.equal(fetched, false, 'cursor mismatch must reject before fetch');
});

test('runs cursor pins workflow, status, and author selectors', async () => {
  const run = {
    id: 1, run_number: 1, name: 'Build', status: 'completed', conclusion: 'success',
    head_branch: 'main', head_sha: 'abc1234', event: 'push',
    html_url: 'https://github.com/o/r/actions/runs/1', created_at: '2024-01-01T00:00:00Z',
  };
  const mock: FetchMock = async () => jsonResponse({ total_count: 1, workflow_runs: [run] }, 200, {
    Link: '<https://api.github.com/repos/o/r/actions/runs?per_page=20&page=2>; rel="next"',
  });
  const first = await withFetch(mock, () => callGithubTool(
    { action: 'runs', owner: 'o', repo: 'r', workflow: 'ci.yml', status: 'completed', author: 'octo' }, { env: {} },
  ));
  const cursor = (first.details as { pagination: { nextCursor?: string } }).pagination.nextCursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0);
  for (const variant of [
    { action: 'runs', owner: 'o', repo: 'r', status: 'completed', author: 'octo', cursor },
    { action: 'runs', owner: 'o', repo: 'r', workflow: 'ci.yml', status: 'queued', author: 'octo', cursor },
    { action: 'runs', owner: 'o', repo: 'r', workflow: 'ci.yml', status: 'completed', author: 'mallory', cursor },
    { action: 'runs', owner: 'o', repo: 'r', workflow: 'ci.yml', status: 'completed', cursor },
  ]) {
    let fetched = false;
    await expectGithubError('cursor_invalid', () => withFetch(async () => {
      fetched = true;
      return jsonResponse({});
    }, () => callGithubTool(variant, { env: {} })));
    assert.equal(fetched, false, `selector change must reject before fetch: ${JSON.stringify(variant)}`);
  }
});

test('jobs pages carry per_page/page and Link-driven cursors', async () => {
  const requested: string[] = [];
  const mock: FetchMock = async (input) => {
    requested.push(String(input));
    const page = /[?&]page=2(?:&|$)/.test(String(input)) ? 2 : 1;
    const jobs = page === 1
      ? [{ id: 11, name: 'build', status: 'completed' }]
      : [{ id: 12, name: 'test', status: 'completed' }];
    return jsonResponse({ total_count: 2, jobs }, 200, page === 1 ? {
      Link: '<https://api.github.com/repos/o/r/actions/runs/99/jobs?per_page=20&page=2>; rel="next"',
    } : {});
  };
  const first = await withFetch(mock, () => callGithubTool(
    { action: 'runs', owner: 'o', repo: 'r', number: 99, jobs: true }, { env: {} },
  ));
  assert.match(requested[0] ?? '', /per_page=20/);
  assert.match(requested[0] ?? '', /page=1/);
  const details = first.details as { pagination: { hasMore: boolean; nextCursor?: string } };
  assert.equal(details.pagination.hasMore, true);
  const cursor = details.pagination.nextCursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0);
  requested.length = 0;
  const second = await withFetch(mock, () => callGithubTool(
    { action: 'runs', owner: 'o', repo: 'r', number: 99, jobs: true, cursor }, { env: {} },
  ));
  assert.match(requested[0] ?? '', /page=2/);
  const entities = (second.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.job_id, 12);
});

// ── Trending degradation ──

test('trending scrape failure degrades cleanly', async () => {
  const result = await withFetch(async () => textResponse('', 500),
    () => callGithubTool({ action: 'trending', limit: 5 }, { env: {} }));
  const details = result.details as {
    entities: unknown[]; partial: boolean; warnings: string[];
    northstar: { status: string };
  };
  assert.deepEqual(details.entities, []);
  assert.equal(details.partial, true);
  assert.match(details.warnings.join('; '), /degraded/);
  assert.equal(details.northstar.status, 'degraded');
});

test('trending abort propagates instead of degrading', async () => {
  const abortError = new DOMException('operation aborted', 'AbortError');
  let calls = 0;
  await assert.rejects(
    withFetch(async () => {
      calls += 1;
      throw abortError;
    }, () => callGithubTool({ action: 'trending', limit: 5 }, { env: {} })),
    (error: unknown) => error === abortError,
  );
  assert.equal(calls, 1);
});

test('repo readme abort propagates instead of degrading', async () => {
  const abortError = new DOMException('operation aborted', 'AbortError');
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/repos/octo/kit')) return jsonResponse(repoRow());
      throw abortError;
    }, () => callGithubTool({ action: 'repo', owner: 'octo', repo: 'kit' }, { env: {} })),
    (error: unknown) => error === abortError,
  );
});

test('repo readme ordinary error propagates when signal aborted before throw', async () => {
  const controller = new AbortController();
  // githubFetch wraps raw fetch failures; the aborted signal must rethrow
  // (not degrade to readme=undefined success) via the signal?.aborted branch.
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/repos/octo/kit')) return jsonResponse(repoRow());
      controller.abort();
      throw new Error('readme fetch failed');
    }, () => callGithubTool({ action: 'repo', owner: 'octo', repo: 'kit' }, { env: {}, signal: controller.signal })),
    /GitHub request failed before any response/,
  );
});

test('trending parses repo slugs', async () => {
  const result = await withFetch(async (input) => {
    assert.match(String(input), /github\.com\/trending\?since=weekly/);
    return textResponse('<h2><a href="/octo/kit">octo / kit</a></h2>');
  }, () => callGithubTool({ action: 'trending', since: 'weekly' }, { env: {} }));
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.kind, 'repo');
  assert.equal(entities[0]?.full_name, 'octo/kit');
});
