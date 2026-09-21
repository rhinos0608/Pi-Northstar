import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeGithubIssues,
  mapGithubIssuesCommandResult,
} from '../../src/commands/github-issues-handler.js';

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
  return createCommandContext({ surface, env: {}, invocationId: `issues-${surface}` });
}

// ── Outcome mapping ──

test('github.issues maps success/degraded/partial/empty statuses', () => {
  for (const [status, outcome] of [
    ['ok', 'success'],
    ['degraded', 'degraded'],
    ['partial', 'partial'],
    ['empty', 'empty'],
  ] as const) {
    const result = mapGithubIssuesCommandResult(
      {
        content: [{ type: 'text', text: 'issues' }],
        details: {
          entities: [],
          northstar: { status, request: { source: 'github-api' }, sources: [{ backend: 'github-api' }], data: { kind: 'entities' } },
        },
      },
      ctx(),
    );
    assert.equal(result.commandId, 'github.issues');
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, 'github.issues');
  }
});

// ── Handler execution: list excludes PR rows ──

test('github.issues list excludes pull-request rows with a warning', async () => {
  const result = await withFetch(
    async () => jsonResponse([
      { number: 1, title: 'real issue', state: 'open' },
      { number: 2, title: 'a pr', state: 'open', pull_request: { url: 'https://api.github.com/x' } },
    ]),
    () => executeGithubIssues({ owner: 'octo', repo: 'kit', state: 'open' }, ctx('pi')),
  );
  const details = result.details as Record<string, unknown>;
  const command = details.northstarCommand as { commandId: string; outcome: string };
  assert.equal(command.commandId, 'github.issues');
  const entities = details.entities as Array<{ number: number }>;
  assert.equal(entities.length, 1);
  assert.equal(entities[0]?.number, 1);
  const warnings = (details.warnings ?? []) as string[];
  assert.ok(warnings.some((w) => w.includes('excluded from issues list')));
});

// ── Handler execution: single-number mode with top comments ──

test('github.issues number mode appends top comments to the body', async () => {
  const result = await withFetch(
    async (input) => {
      const url = String(input);
      if (url.endsWith('/comments?per_page=50')) return jsonResponse([{ body: 'helpful comment', user: { login: 'amy' } }]);
      return jsonResponse({ number: 7, title: 'bug', state: 'open', body: 'base body' });
    },
    () => executeGithubIssues({ owner: 'octo', repo: 'kit', number: 7 }, ctx()),
  );
  const entities = (result.details as Record<string, unknown>).entities as Array<{ body: string }>;
  assert.equal(entities.length, 1);
  assert.match(entities[0]!.body, /base body/);
  assert.match(entities[0]!.body, /Top comments/);
  assert.match(entities[0]!.body, /@amy/);
});

// ── Contract semantics preserved ──

test('github.issues rejects out-of-range limit instead of clamping', async () => {
  await assert.rejects(
    executeGithubIssues({ owner: 'octo', repo: 'kit', limit: 51 }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('github.issues rejects a cursor pinned to another action', async () => {
  const { encodeGithubCursor, githubCursorFingerprint } = await import('../../src/github/github-contract.js');
  const fingerprint = githubCursorFingerprint({ action: 'pulls', owner: 'octo', repo: 'kit', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'pulls', backend: 'github-api', fingerprint, state: { page: 2 } });
  await assert.rejects(
    executeGithubIssues({ owner: 'octo', repo: 'kit', cursor }, ctx()),
    (error: unknown) => (error as { code?: string }).code === 'cursor_invalid',
  );
});

test('github.issues surfaces auth failure as terminal', async () => {
  await withFetch(
    async () => new Response('unauthorized', { status: 401 }),
    () => assert.rejects(
      executeGithubIssues({ owner: 'octo', repo: 'kit' }, ctx()),
      (error: unknown) => (error as { code?: string }).code === 'authentication_required',
    ),
  );
});

test('github.issues maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeGithubIssues({ owner: 'octo', repo: 'kit' }, createCommandContext({ surface: 'cli', env: {}, signal: controller.signal })),
    (error: unknown) => (error as { commandResult?: { outcome?: string } }).commandResult?.outcome === 'cancelled',
  );
});
