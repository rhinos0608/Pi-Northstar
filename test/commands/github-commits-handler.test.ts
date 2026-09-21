import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGithubCommits,
  mapGithubCommitsCommandResult,
} from '../../src/commands/github-commits-handler.js';
import { runCommand } from '../../src/cli/cli.js';

function jsonResponse(body: unknown, status = 200, link: string | null = null): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (link !== null) headers.link = link;
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

function ctx(surface = 'cli') {
  return createCommandContext({ surface, env: {}, invocationId: `commits-${surface}` });
}

const commit = {
  sha: 'abc1234def',
  html_url: 'https://github.com/octo/kit/commit/abc1234def',
  commit: { message: 'fix it', author: { name: 'dev', date: '2024-02-02T00:00:00Z' } },
  author: { login: 'dev' },
};

// ── Outcome mapping ──

test('github.commits maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubCommitsCommandResult(
      {
        content: [{ type: 'text', text: 'commits' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.commits');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.commits');
  }
});

// ── Handler execution: sha-vs-list dual mode with selectors ──

test('github.commits sha mode fetches the single-commit endpoint', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(commit);
    },
    () => executeGithubCommits({ owner: 'octo', repo: 'kit', sha: 'abc1234' }, ctx('pi')),
  );
  assert.ok(seen.some((url) => url.includes('/commits/abc1234')));
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.commits');
});

test('github.commits list mode forwards path/author/since/ref selectors', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([commit]);
    },
    () => executeGithubCommits(
      { owner: 'octo', repo: 'kit', path: 'src/a.ts', author: 'dev', since: '2024-01-01T00:00:00Z', ref: 'main' },
      ctx(),
    ),
  );
  const url = seen.find((candidate) => candidate.includes('/commits?'));
  assert.ok(url?.includes('path=src%2Fa.ts') || url?.includes('path=src/a.ts'), `path selector must reach upstream: ${url}`);
  assert.ok(url?.includes('author=dev'), `author selector must reach upstream: ${url}`);
  assert.ok(url?.includes('since=2024'), `since selector must reach upstream: ${url}`);
  assert.ok(url?.includes('sha=main'), `ref selector must reach upstream as sha: ${url}`);
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string; sha: string }>;
  assert.equal(entities[0]?.kind, 'commit');
  assert.equal(entities[0]?.sha, 'abc1234def');
});

test('github.commits list mode accepts branch as the ref selector', async () => {
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([commit]);
    },
    () => executeGithubCommits({ owner: 'octo', repo: 'kit', branch: 'main' }, ctx()),
  );
  assert.ok(seen.some((url) => url.includes('sha=main')), 'branch must reach upstream as sha');
});

// ── Contract semantics preserved ──

test('github.commits rejects out-of-range limit instead of clamping', async () => {
  await assert.rejects(
    executeGithubCommits({ owner: 'octo', repo: 'kit', limit: 51 }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.commits rejects a cursor pinned to another action', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'releases', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'releases', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubCommits({ owner: 'octo', repo: 'kit', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.commits rejects a cursor reused with different result-shaping selectors', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const base = { action: 'commits' as const, owner: 'octo', repo: 'kit', limit: 20 };
  for (const variant of [
    { path: 'src/a.ts' },
    { author: 'dev' },
    { since: '2024-01-01T00:00:00Z' },
    { branch: 'main' },
    { sha: 'abc1234' },
  ] as const) {
    const cursor = encodeGithubCursor({ action: 'commits', backend: 'github-api', fingerprint: githubCursorFingerprint(base), state: { page: 2 } });
    await assert.rejects(
      executeGithubCommits({ owner: 'octo', repo: 'kit', ...variant, cursor }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
      `cursor must fail closed when ${Object.keys(variant)[0]} changes`,
    );
  }
});

test('github.commits surfaces rate limit as terminal with retry metadata', async () => {
  await withFetch(
    async () => new Response('limited', { status: 429 }),
    () => assert.rejects(
      executeGithubCommits({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'rate_limited',
    ),
  );
});

test('github.commits maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeGithubCommits({ owner: 'octo', repo: 'kit' }, createCommandContext({ surface: 'cli', env: {}, signal: controller.signal })),
    (error: unknown) => (error as { commandResult?: { outcome?: string } }).commandResult?.outcome === 'cancelled',
  );
});

// ── CLI: every advertised selector reaches the domain (accept-then-drop probes) ──

test('cli github commits forwards every list selector upstream', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([commit]);
    },
    () => runCommand(['github', 'commits', 'octo/kit', '--path', 'src/a.ts', '--author', 'dev', '--since', '2024-01-01T00:00:00Z', '--ref', 'main'], {}),
  );
  const url = seen.find((candidate) => candidate.includes('/commits?'));
  assert.ok(url, 'CLI list selectors must reach the domain list endpoint');
  assert.ok(url.includes('author=dev'), `--author dropped: ${url}`);
  assert.ok(url.includes('since=2024'), `--since dropped: ${url}`);
  assert.ok(url.includes('sha=main'), `--ref dropped: ${url}`);
  assert.equal(result.ok, true);
});

test('cli github commits forwards --sha, --branch, --limit, and --cursor', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(commit);
    },
    () => runCommand(['github', 'commits', 'octo/kit', '--sha', 'abc1234'], {}),
  );
  assert.ok(seen.some((url) => url.includes('/commits/abc1234')), 'CLI --sha must reach the domain');
  seen.length = 0;
  await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([commit]);
    },
    () => runCommand(['github', 'commits', 'octo/kit', '--branch', 'main', '--limit', '5'], {}),
  );
  assert.ok(seen.some((url) => url.includes('sha=main') && url.includes('per_page=5')), 'CLI --branch/--limit must reach the domain');
  seen.length = 0;
  const requestLimit = 5;
  const fingerprint = githubCursorFingerprint({ action: 'commits', owner: 'octo', repo: 'kit', limit: requestLimit });
  const cursor = encodeGithubCursor({ action: 'commits', backend: 'github-api', fingerprint, state: { page: 2 } });
  const link = '<https://api.github.com/repos/octo/kit/commits?per_page=5&page=3>; rel="next"';
  const paged = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([commit], 200, link);
    },
    () => runCommand(['github', 'commits', 'octo/kit', '--limit', String(requestLimit), '--cursor', cursor], {}),
  );
  assert.ok(seen.some((url) => url.includes('page=2')), 'CLI --cursor must reach the domain');
  assert.equal(paged.ok, true);
});

test('cli github commits rejects unknown and duplicate flags', async () => {
  assert.equal((await runCommand(['github', 'commits', 'octo/kit', '--bogus', 'x'], {})).error?.code, 'unknown_flag');
  assert.equal((await runCommand(['github', 'commits', 'octo/kit', '--sha', 'abc1234', '--sha', 'abc1234'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'commits', 'octo/kit', '--author'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['github', 'commits', 'not-a-slug'], {})).error?.code, 'invalid_usage');
});

// ── Bypass closure: native tool routes through the registry handler ──

test('github.commits native-tool call resolves through the command registry', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const { commandSurface } = await import('../../src/commands/command-registry.js');
  assert.ok(commandSurface().includes('github.commits'));
  const result = await withFetch(
    async () => jsonResponse([commit]),
    () => callNativeTool('github', { action: 'commits', owner: 'octo', repo: 'kit' }, { env: {} }),
  );
  const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string };
  assert.equal(command.commandId, 'github.commits');
});
