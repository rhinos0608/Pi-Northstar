import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import { commandHandler } from '../../src/commands/command-registry.js';
import {
  executeGithubSearch,
  mapGithubSearchCommandResult,
} from '../../src/commands/github-search-handler.js';
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

const CODE_ITEMS = {
  items: [
    {
      path: 'src/index.ts',
      name: 'index.ts',
      html_url: 'https://github.com/octo/kit/blob/main/src/index.ts',
      repository: { full_name: 'octo/kit' },
    },
  ],
};
const NEXT_LINK = '<https://api.github.com/search/code?q=alpha&per_page=5&page=2>; rel="next"';

function ctx(surface = 'cli') {
  return createCommandContext({ surface, env: {}, invocationId: `search-${surface}` });
}

type CommandFailure = { commandResult?: { outcome: string; error: { code: string; retryable: boolean } } };

// ── Outcome mapping ──

test('github.search maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubSearchCommandResult(
      {
        content: [{ type: 'text', text: 'search' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.search');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.search');
  }
});

// ── Handler execution ──

test('github.search handler runs code search and stamps command identity', async () => {
  const seen: string[] = [];
  const result = await withFetch(async (input) => {
    seen.push(String(input));
    return jsonResponse(CODE_ITEMS);
  }, () => executeGithubSearch({ query: 'alpha', limit: 5 }, ctx('pi')));
  const details = result.details as Record<string, unknown>;
  const command = details.northstarCommand as { commandId: string; outcome: string };
  assert.equal(command.commandId, 'github.search');
  assert.equal(command.outcome, 'success');
  assert.match(decodeURIComponent(seen[0]!), /q=alpha/);
  const entities = details.entities as Array<{ id: string }>;
  assert.deepEqual(entities.map((e) => e.id), ['github:code:octo/kit:src/index.ts']);
});

test('github.search language scopes the query instead of dropping', async () => {
  const seen: string[] = [];
  await withFetch(async (input) => {
    seen.push(String(input));
    return jsonResponse(CODE_ITEMS);
  }, () => executeGithubSearch({ query: 'alpha', language: 'typescript', limit: 5 }, ctx()));
  assert.match(decodeURIComponent(seen[0]!), /language:typescript/);
});

test('github.search perPage aliases limit and wins when both present', async () => {
  const seen: string[] = [];
  await withFetch(async (input) => {
    seen.push(String(input));
    return jsonResponse(CODE_ITEMS);
  }, () => executeGithubSearch({ query: 'alpha', limit: 2, perPage: 7 }, ctx()));
  assert.match(seen[0]!, /per_page=7/);
});

test('github.search abort maps to cancelled', async () => {
  const abortError = new DOMException('operation aborted', 'AbortError');
  try {
    await withFetch(async () => { throw abortError; }, () => executeGithubSearch({ query: 'alpha' }, ctx()));
    assert.fail('expected abort to throw');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'cancelled');
    assert.equal(command?.error.code, 'cancelled');
  }
});

// ── Validation terminality ──

test('github.search validation failures are terminal failed/invalid_request', async () => {
  for (const args of [
    {},
    { query: '' },
    { query: '   ' },
    { query: 'x', limit: 0 },
    { query: 'x', limit: 51 },
    { query: 'x', perPage: 51 },
    { query: 'x', bogus: 1 },
    { repository: 'octo/kit' },
  ]) {
    try {
      await executeGithubSearch(args, ctx());
      assert.fail(`expected rejection for ${JSON.stringify(args)}`);
    } catch (error) {
      const command = (error as CommandFailure).commandResult;
      assert.equal(command?.outcome, 'failed', JSON.stringify(args));
      assert.equal(command?.error.code, 'invalid_request', JSON.stringify(args));
    }
  }
});

test('github.search auth and rate limits map without silent fallback', async () => {
  try {
    await withFetch(async () => jsonResponse({ message: 'bad' }, 401), () => executeGithubSearch({ query: 'alpha' }, ctx()));
    assert.fail('expected auth failure');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'failed');
    assert.equal(command?.error.code, 'authentication_required');
    assert.equal(command?.error.retryable, false);
  }
  try {
    await withFetch(async () => jsonResponse({ message: 'limited' }, 403), () => executeGithubSearch({ query: 'alpha' }, ctx()));
    assert.fail('expected rate limit');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'failed');
    assert.equal(command?.error.code, 'rate_limited');
    assert.equal(command?.error.retryable, true);
  }
});

// ── Cursor pinning to action+query ──

test('github.search cursor fingerprint binds query and language', () => {
  const base = { action: 'search' as const, limit: 5 };
  const a = githubCursorFingerprint({ ...base, query: 'alpha' });
  const b = githubCursorFingerprint({ ...base, query: 'beta' });
  const c = githubCursorFingerprint({ ...base, query: 'alpha', language: 'typescript' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('github.search cursor from another query fails closed as cursor_invalid', async () => {
  const first = await withFetch(async () => jsonResponse(CODE_ITEMS, 200, NEXT_LINK), () =>
    executeGithubSearch({ query: 'alpha', limit: 5 }, ctx()));
  const cursor = (first.details as { pagination: { nextCursor?: string } }).pagination.nextCursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0);
  let fetched = 0;
  try {
    await withFetch(async () => {
      fetched += 1;
      return jsonResponse(CODE_ITEMS);
    }, () => executeGithubSearch({ query: 'beta', limit: 5, cursor }, ctx()));
    assert.fail('expected cursor mismatch to throw');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'failed');
    assert.equal(command?.error.code, 'cursor_invalid');
    assert.equal(fetched, 0);
  }
});

test('github.search cursor survives identical query and language', async () => {
  const first = await withFetch(async () => jsonResponse(CODE_ITEMS, 200, NEXT_LINK), () =>
    executeGithubSearch({ query: 'alpha', limit: 5 }, ctx()));
  const cursor = (first.details as { pagination: { nextCursor?: string } }).pagination.nextCursor;
  assert.ok(cursor);
  const seen: string[] = [];
  await withFetch(async (input) => {
    seen.push(String(input));
    return jsonResponse(CODE_ITEMS);
  }, () => executeGithubSearch({ query: 'alpha', limit: 5, cursor }, ctx()));
  assert.match(seen[0]!, /page=2/);
});

test('github.search foreign cursor minted for search_repos is rejected', async () => {
  const foreign = encodeGithubCursor({
    action: 'search_repos',
    backend: 'github-api',
    fingerprint: githubCursorFingerprint({ action: 'search_repos', query: 'alpha', limit: 5 }),
    state: { page: 2 },
  });
  try {
    await executeGithubSearch({ query: 'alpha', limit: 5, cursor: foreign }, ctx());
    assert.fail('expected cross-action cursor to throw');
  } catch (error) {
    assert.equal((error as CommandFailure).commandResult?.error.code, 'cursor_invalid');
  }
});

// ── Scoped credentials ──

test('github.search sends bearer only from scoped env and never echoes it', async () => {
  const seen: Array<Record<string, string>> = [];
  await withFetch(async (_input, init) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    return jsonResponse(CODE_ITEMS);
  }, () => executeGithubSearch({ query: 'alpha' }, createCommandContext({ surface: 'cli', env: { GITHUB_TOKEN: 'scoped-secret' } })));
  assert.equal(seen[0]!.Authorization, 'Bearer scoped-secret');
  await withFetch(async (_input, init) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    return jsonResponse(CODE_ITEMS);
  }, () => executeGithubSearch({ query: 'alpha' }, ctx()));
  assert.equal(seen[1]!.Authorization, undefined);
  try {
    await withFetch(async () => jsonResponse({ message: 'bad' }, 401), () =>
      executeGithubSearch({ query: 'alpha' }, createCommandContext({ surface: 'cli', env: { GITHUB_TOKEN: 'scoped-secret' } })));
    assert.fail('expected auth failure');
  } catch (error) {
    const command = (error as { commandResult?: { error: { message: string } } }).commandResult;
    assert.ok(!String(command?.error.message).includes('scoped-secret'));
  }
});

// ── Registry + Pi/native parity (bypass closure) ──

test('github.search resolves through the command registry', () => {
  assert.equal(commandHandler('github.search').commandId, 'github.search');
});

test('native github search routes through the handler, not raw dispatch', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const result = await withFetch(async () => jsonResponse(CODE_ITEMS), () =>
    callNativeTool('github', { action: 'search', query: 'alpha', limit: 3 }, { env: {} }));
  const command = ((result.details as Record<string, unknown>).northstarCommand ?? {}) as {
    commandId?: string;
    outcome?: string;
  };
  assert.equal(command.commandId, 'github.search');
  assert.equal(command.outcome, 'success');
});

test('Pi github search routes through the handler', async () => {
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
  const outcome = await withFetch(async () => jsonResponse(CODE_ITEMS), () =>
    execute('id', { action: 'search', query: 'alpha', limit: 3 }));
  const wrapped = (outcome as { details: { details: Record<string, unknown> } }).details;
  const command = wrapped.details.northstarCommand as { commandId: string; outcome: string };
  assert.equal(command.commandId, 'github.search');
  assert.equal(command.outcome, 'success');
});

// ── CLI grammar ──

test('CLI github search help, strict rejection, and success modes', async () => {
  const { runCommand } = await import('../../src/cli/cli.js');
  const help = await runCommand(['github', 'search', '--help'], {});
  assert.equal(help.ok, true);
  assert.equal((help.data as { commandId: string }).commandId, 'github.search');
  assert.match((help.data as { usage: string }).usage, /northstar github search QUERY/);

  for (const args of [
    ['github', 'search'],
    ['github', 'search', 'a', 'b'],
    ['github', 'search', 'alpha', '--bogus'],
    ['github', 'search', 'alpha', '--language'],
    ['github', 'search', 'alpha', '--limit'],
    ['github', 'search', 'alpha', '--limit', 'abc'],
    ['github', 'search', 'alpha', '--limit', '0'],
    ['github', 'search', 'alpha', '--language', 'ts', '--language', 'js'],
    ['github', 'search', 'alpha', '--json', '--agent'],
    ['github', 'search', 'alpha', '--json', '--json'],
  ]) {
    const rejected = await runCommand(args, {});
    assert.equal(rejected.ok, false, args.join(' '));
  }

  const overCap = await runCommand(['github', 'search', 'alpha', '--limit', '999'], {});
  assert.equal(overCap.ok, false);
  assert.match(String((overCap.data as string) ?? ''), /invalid_request/);

  const human = await withFetch(async () => jsonResponse(CODE_ITEMS), () =>
    runCommand(['github', 'search', 'alpha', '--language', 'typescript', '--limit', '5'], {}));
  assert.equal(human.ok, true);
  assert.match(String(human.data), /github\.search: success/);

  const json = await withFetch(async () => jsonResponse(CODE_ITEMS), () =>
    runCommand(['github', 'search', 'alpha', '--json'], {}));
  assert.equal(json.ok, true);
  const parsed = JSON.parse(String(json.data));
  assert.equal(parsed.commandId, 'github.search');
  assert.equal(parsed.outcome, 'success');
});
