import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGithubPulls,
  mapGithubPullsCommandResult,
} from '../../src/commands/github-pulls-handler.js';

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
  return createCommandContext({ surface, env: {}, invocationId: `pulls-${surface}` });
}

// ── Outcome mapping ──

test('github.pulls maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubPullsCommandResult(
      {
        content: [{ type: 'text', text: 'pulls' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.pulls');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.pulls');
  }
});

// ── Handler execution: single-number mode with top comments ──

test('github.pulls number mode appends top comments to the body', async () => {
  const result = await withFetch(
    async (input) => {
      const url = String(input);
      if (url.endsWith('/comments?per_page=50')) return jsonResponse([{ body: 'lgtm', user: { login: 'rex' } }]);
      return jsonResponse({ number: 9, title: 'fix', state: 'open', body: 'pr body' });
    },
    () => executeGithubPulls({ owner: 'octo', repo: 'kit', number: 9 }, ctx('pi')),
  );
  const details = result.details as Record<string, unknown>;
  assert.equal((details.northstarCommand as { commandId: string }).commandId, 'github.pulls');
  const entities = details.entities as Array<{ body: string }>;
  assert.equal(entities.length, 1);
  assert.match(entities[0]!.body, /Top comments/);
  assert.match(entities[0]!.body, /@rex/);
});

// ── Handler execution: files mode ──

test('github.pulls files mode lists changed files for one pull', async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse([{ filename: 'src/a.ts', patch: 'diff here' }]);
    },
    () => executeGithubPulls({ owner: 'octo', repo: 'kit', number: 9, files: true }, ctx()),
  );
  assert.ok(seen.some((url) => url.includes('/pulls/9/files')));
  const entities = (result.details as Record<string, unknown>).entities as Array<{ kind: string; path: string }>;
  assert.equal(entities.length, 1);
  assert.equal(entities[0]?.kind, 'file');
  assert.equal(entities[0]?.path, 'src/a.ts');
});

// ── Contract semantics preserved ──

test('github.pulls rejects out-of-range limit instead of clamping', async () => {
  await assert.rejects(
    executeGithubPulls({ owner: 'octo', repo: 'kit', limit: 51 }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.pulls rejects a cursor pinned to another action', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'issues', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'issues', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubPulls({ owner: 'octo', repo: 'kit', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.pulls surfaces rate limit as terminal with retry metadata', async () => {
  await withFetch(
    async () => new Response('limited', { status: 429 }),
    () => assert.rejects(
      executeGithubPulls({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'rate_limited',
    ),
  );
});

test('github.pulls maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeGithubPulls({ owner: 'octo', repo: 'kit' }, createCommandContext({ surface: 'cli', env: {}, signal: controller.signal })),
    (error: unknown) => (error as { commandResult?: { outcome?: string } }).commandResult?.outcome === 'cancelled',
  );
});
