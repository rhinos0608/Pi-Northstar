import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import { commandHandler } from '../../src/commands/command-registry.js';
import {
  executeGithubSearchRepos,
  mapGithubSearchReposCommandResult,
} from '../../src/commands/github-search-repos-handler.js';
import {
  encodeGithubCursor,
  githubCursorFingerprint,
} from '../../src/github/github-contract.js';

function jsonResponse(body: unknown, status = 200, link?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (link !== undefined) headers.link = link;
  return new Response(JSON.stringify(body), { status, headers });
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

const REPO_ITEMS = {
  items: [
    {
      full_name: 'octo/kit',
      name: 'kit',
      html_url: 'https://github.com/octo/kit',
      description: 'a kit',
      stargazers_count: 10,
      language: 'TypeScript',
    },
  ],
};
const NEXT_LINK = '<https://api.github.com/search/repositories?q=alpha&per_page=5&page=2>; rel="next"';

function ctx(surface = 'cli') {
  return createCommandContext({ surface, env: {}, invocationId: `search-repos-${surface}` });
}

type CommandFailure = { commandResult?: { outcome: string; error: { code: string; retryable: boolean } } };

// ── Outcome mapping ──

test('github.search_repos maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubSearchReposCommandResult(
      {
        content: [{ type: 'text', text: 'search-repos' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.search_repos');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.search_repos');
  }
});

// ── Handler execution ──

test('github.search_repos handler runs repository search and stamps command identity', async () => {
  const seen: string[] = [];
  const result = await withFetch(async (input) => {
    seen.push(String(input));
    return jsonResponse(REPO_ITEMS);
  }, () => executeGithubSearchRepos({ query: 'alpha', limit: 5 }, ctx('pi')));
  const details = result.details as Record<string, unknown>;
  const command = details.northstarCommand as { commandId: string; outcome: string };
  assert.equal(command.commandId, 'github.search_repos');
  assert.equal(command.outcome, 'success');
  assert.match(seen[0]!, /search\/repositories/);
  const entities = details.entities as Array<{ full_name: string }>;
  assert.deepEqual(entities.map((e) => e.full_name), ['octo/kit']);
});

test('github.search_repos language scopes the query instead of dropping', async () => {
  const seen: string[] = [];
  await withFetch(async (input) => {
    seen.push(String(input));
    return jsonResponse(REPO_ITEMS);
  }, () => executeGithubSearchRepos({ query: 'alpha', language: 'typescript', limit: 5 }, ctx()));
  assert.match(decodeURIComponent(seen[0]!), /language:typescript/);
});

test('github.search_repos perPage aliases limit and wins when both present', async () => {
  const seen: string[] = [];
  await withFetch(async (input) => {
    seen.push(String(input));
    return jsonResponse(REPO_ITEMS);
  }, () => executeGithubSearchRepos({ query: 'alpha', limit: 2, perPage: 7 }, ctx()));
  assert.match(seen[0]!, /per_page=7/);
});

test('github.search_repos abort maps to cancelled', async () => {
  const abortError = new DOMException('operation aborted', 'AbortError');
  try {
    await withFetch(async () => { throw abortError; }, () => executeGithubSearchRepos({ query: 'alpha' }, ctx()));
    assert.fail('expected abort to throw');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'cancelled');
    assert.equal(command?.error.code, 'cancelled');
  }
});

// ── Validation terminality ──

test('github.search_repos validation failures are terminal failed/invalid_request', async () => {
  for (const args of [
    {},
    { query: '' },
    { query: 'x', limit: 0 },
    { query: 'x', limit: 51 },
    { query: 'x', perPage: 100 },
    { query: 'x', bogus: 1 },
    { query: 'x', owner: 'octo', repo: 'kit' },
  ]) {
    try {
      await executeGithubSearchRepos(args, ctx());
      assert.fail(`expected rejection for ${JSON.stringify(args)}`);
    } catch (error) {
      const command = (error as CommandFailure).commandResult;
      assert.equal(command?.outcome, 'failed', JSON.stringify(args));
      assert.equal(command?.error.code, 'invalid_request', JSON.stringify(args));
    }
  }
});

test('github.search_repos auth and rate limits map without silent fallback', async () => {
  try {
    await withFetch(async () => jsonResponse({ message: 'bad' }, 401), () => executeGithubSearchRepos({ query: 'alpha' }, ctx()));
    assert.fail('expected auth failure');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'failed');
    assert.equal(command?.error.code, 'authentication_required');
    assert.equal(command?.error.retryable, false);
  }
  try {
    await withFetch(async () => jsonResponse({ message: 'limited' }, 429), () => executeGithubSearchRepos({ query: 'alpha' }, ctx()));
    assert.fail('expected rate limit');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'failed');
    assert.equal(command?.error.code, 'rate_limited');
    assert.equal(command?.error.retryable, true);
  }
});

// ── Cursor pinning to action+query ──

test('github.search_repos cursor fingerprint binds query and language', () => {
  const base = { action: 'search_repos' as const, limit: 5 };
  const a = githubCursorFingerprint({ ...base, query: 'alpha' });
  const b = githubCursorFingerprint({ ...base, query: 'beta' });
  const c = githubCursorFingerprint({ ...base, query: 'alpha', language: 'rust' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('github.search_repos cursor from another query fails closed as cursor_invalid', async () => {
  const first = await withFetch(async () => jsonResponse(REPO_ITEMS, 200, NEXT_LINK), () =>
    executeGithubSearchRepos({ query: 'alpha', limit: 5 }, ctx()));
  const cursor = (first.details as { pagination: { nextCursor?: string } }).pagination.nextCursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0);
  let fetched = 0;
  try {
    await withFetch(async () => {
      fetched += 1;
      return jsonResponse(REPO_ITEMS);
    }, () => executeGithubSearchRepos({ query: 'beta', limit: 5, cursor }, ctx()));
    assert.fail('expected cursor mismatch to throw');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'failed');
    assert.equal(command?.error.code, 'cursor_invalid');
    assert.equal(fetched, 0);
  }
});

test('github.search_repos foreign cursor minted for code search is rejected', async () => {
  const foreign = encodeGithubCursor({
    action: 'search',
    backend: 'github-api',
    fingerprint: githubCursorFingerprint({ action: 'search', query: 'alpha', limit: 5 }),
    state: { page: 2 },
  });
  try {
    await executeGithubSearchRepos({ query: 'alpha', limit: 5, cursor: foreign }, ctx());
    assert.fail('expected cross-action cursor to throw');
  } catch (error) {
    assert.equal((error as CommandFailure).commandResult?.error.code, 'cursor_invalid');
  }
});

// ── Registry + Pi/native parity (bypass closure) ──

test('github.search_repos resolves through the command registry', () => {
  assert.equal(commandHandler('github.search_repos').commandId, 'github.search_repos');
});

test('native github search_repos routes through the handler, not raw dispatch', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const result = await withFetch(async () => jsonResponse(REPO_ITEMS), () =>
    callNativeTool('github', { action: 'search_repos', query: 'alpha', limit: 3 }, { env: {} }));
  const command = ((result.details as Record<string, unknown>).northstarCommand ?? {}) as {
    commandId?: string;
    outcome?: string;
  };
  assert.equal(command.commandId, 'github.search_repos');
  assert.equal(command.outcome, 'success');
});

test('Pi github search_repos routes through the handler', async () => {
  const { registerGitHubTool } = await import('../../src/github/github.js');
  let execute!: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  const pi = {
    on: () => {},
    registerTool: (def: { name: string; execute: typeof execute }) => {
      if (def.name === 'github') execute = def.execute;
    },
    registerCommand: () => {},
  };
  registerGitHubTool(pi as never, { callTool: async () => ({}), close: async () => {} } as never, {});
  const outcome = await withFetch(async () => jsonResponse(REPO_ITEMS), () =>
    execute('id', { request: { action: 'search_repos', query: 'alpha', limit: 3 } }));
  const wrapped = (outcome as { details: { details: Record<string, unknown> } }).details;
  const command = wrapped.details.northstarCommand as { commandId: string; outcome: string };
  assert.equal(command.commandId, 'github.search_repos');
  assert.equal(command.outcome, 'success');
});

// ── CLI grammar (hyphen canonical, underscore alias) ──

test('CLI github search-repos help, strict rejection, and success modes', async () => {
  const { runCommand } = await import('../../src/cli/cli.js');
  for (const spelling of ['search-repos', 'search_repos']) {
    const help = await runCommand(['github', spelling, '--help'], {});
    assert.equal(help.ok, true, spelling);
    assert.equal((help.data as { commandId: string }).commandId, 'github.search_repos', spelling);
    assert.match((help.data as { usage: string }).usage, /northstar github search-repos QUERY/, spelling);
  }

  for (const args of [
    ['github', 'search-repos'],
    ['github', 'search-repos', 'a', 'b'],
    ['github', 'search-repos', 'alpha', '--bogus'],
    ['github', 'search-repos', 'alpha', '--limit', 'abc'],
    ['github', 'search-repos', 'alpha', '--json', '--agent'],
    ['github', 'search-repos', 'alpha', 'extra-positional'],
  ]) {
    const rejected = await runCommand(args, {});
    assert.equal(rejected.ok, false, args.join(' '));
  }

  const overCap = await runCommand(['github', 'search-repos', 'alpha', '--limit', '999'], {});
  assert.equal(overCap.ok, false);
  assert.match(String((overCap.data as string) ?? ''), /invalid_request/);

  const human = await withFetch(async () => jsonResponse(REPO_ITEMS), () =>
    runCommand(['github', 'search-repos', 'alpha', '--limit', '5'], {}));
  assert.equal(human.ok, true);
  assert.match(String(human.data), /github\.search_repos: success/);

  const alias = await withFetch(async () => jsonResponse(REPO_ITEMS), () =>
    runCommand(['github', 'search_repos', 'alpha'], {}));
  assert.equal(alias.ok, true);

  const json = await withFetch(async () => jsonResponse(REPO_ITEMS), () =>
    runCommand(['github', 'search-repos', 'alpha', '--json'], {}));
  assert.equal(json.ok, true);
  const parsed = JSON.parse(String(json.data));
  assert.equal(parsed.commandId, 'github.search_repos');
  assert.equal(parsed.outcome, 'success');
});
