import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeSearchWeb, mapSearchWebCommandResult, parseSearchWebArgs, SEARCH_WEB_COMMAND } from '../../src/commands/search-web-handler.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import { validateCommandResult } from '../../src/commands/command-result.js';

function ctx(options: { env?: Record<string, string | undefined>; signal?: AbortSignal } = {}) {
  return createCommandContext({
    surface: 'test',
    env: options.env ?? { PI_SEARCH_WEB_BACKENDS: 'duckduckgo' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

test('search.web: argument parser rejects cursors and unknown fields', () => {
  assert.throws(() => parseSearchWebArgs({}), /query or queries\[1\.\.8\] is required/);
  assert.throws(() => parseSearchWebArgs({ query: '' }), /query must be a non-empty string/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', queries: ['test'] }), /accepts either query or queries/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', cursor: 'opaque' }), /cursor requires category "research"/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', source: 'arxiv' }), /unknown field 'source'/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', unexpected: true }), /unknown field 'unexpected'/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', action: 'invalid' }), /Unsupported search action/);
});

test('search.web: out-of-range bounds are rejected instead of clamped', () => {
  assert.throws(() => parseSearchWebArgs({ query: 'test', limit: 0 }), /limit must be an integer 1\.\.20/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', limit: 25 }), /limit must be an integer 1\.\.20/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', yearFrom: 999 }), /four-digit year/);
  assert.throws(() => parseSearchWebArgs({ query: 'test', yearFrom: 3000 }), /four-digit year/);
});

test('search.web: cancellation via AbortSignal marks outcome cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => executeSearchWeb({ query: 'test cancellation' }, ctx({ signal: controller.signal })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const commandResult = (error as { commandResult?: { outcome: string; error?: { code: string } } }).commandResult;
      assert.ok(commandResult);
      assert.equal(commandResult.outcome, 'cancelled');
      assert.equal(commandResult.error?.code, 'cancelled');
      return true;
    },
  );
});

test('search.web: successful search produces validated command result envelope with cached responseId', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return new Response(
        '<html><body><div><a class="result__a" href="https://example.com/item1">Item 1 Title</a>' +
        '<a class="result__snippet" href="https://example.com/item1">Snippet for item 1</a></div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await executeSearchWeb({ query: 'test item' }, ctx());
    const commandResult = (result.details as Record<string, unknown>).northstarCommand;
    const validation = validateCommandResult(commandResult);
    assert.equal(validation.ok, true, `Validation failed: ${validation.issues.join('; ')}`);
    const validated = validation.result!;
    assert.equal(validated.commandId, SEARCH_WEB_COMMAND);
    assert.equal(validated.outcome, 'success');
    assert.equal(validated.trust, 'external');
    assert.ok(validated.sources.length > 0);
    assert.ok((validated.data as { responseId?: string }).responseId, 'must provide responseId in data');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('search.web: batch search exposes no reusable responseId (false-provenance gate)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('q') ?? 'unknown';
    const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return new Response(
      `<html><body><div><a class="result__a" href="https://example.com/${slug}">Title for ${query}</a>` +
      `<a class="result__snippet" href="https://example.com/${slug}">Snippet for ${query}</a></div></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  try {
    const result = await executeSearchWeb({ queries: ['alpha query', 'beta query'] }, ctx());
    const details = result.details as Record<string, unknown>;
    assert.equal(details.responseId, undefined, 'batch details must not carry a reusable responseId');
    const commandResult = details.northstarCommand as { outcome: string; data: Record<string, unknown> };
    assert.ok(commandResult);
    assert.equal(commandResult.outcome, 'success', 'batch hits still succeed; only the cache pointer is gated');
    assert.equal((commandResult.data as { responseId?: unknown }).responseId, undefined, 'batch command data must not carry responseId');
    const hits = details.results as unknown[];
    assert.equal(hits.length, 2, 'batch fusion order/results unchanged');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('search.web: sole Brave 401 error envelope maps to failed, never empty/success', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://api.search.brave.com/')) {
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
  try {
    const env = { BRAVE_API_KEY: 'fake-test-key', PI_SEARCH_WEB_BACKENDS: 'brave' };
    const result = await executeSearchWeb({ query: 'sole brave failure' }, ctx({ env }));
    const details = result.details as Record<string, unknown>;
    const northstar = details.northstar as { status: string; errors: Array<{ code: string; message: string; retryable: boolean }> };
    assert.equal(northstar.status, 'error', 'canonical seam must report error, not zero results');
    const command = details.northstarCommand as {
      outcome: string; error?: { code: string; message: string; retryable: boolean }; data: unknown;
    };
    const validation = validateCommandResult(command);
    assert.equal(validation.ok, true, `Validation failed: ${validation.issues.join('; ')}`);
    assert.equal(command.outcome, 'failed', 'zero-hit error envelope must never become success/empty');
    assert.ok(command.error, 'failed outcome must preserve failure details');
    assert.equal(command.error!.retryable, false, 'degraded-failure envelope stays non-retryable');
    assert.ok(typeof command.error!.code === 'string' && command.error!.code.length > 0);
    assert.ok(typeof command.error!.message === 'string' && command.error!.message.length > 0);
    assert.equal(command.data, null, 'failed outcome carries no responseId-bearing data');
    assert.equal(details.responseId, undefined, 'failed envelope must not mint a reusable responseId');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('search.web: canonical status mapping covers success/empty/partial/degraded/error', () => {
  const hit = { title: 'Item', url: 'https://example.com/item', snippet: 'snip', source: 'duckduckgo' };
  const mapped = (
    status: string,
    errors: Array<{ code: string; message: string; retryable: boolean }>,
    results: unknown[],
  ) => mapSearchWebCommandResult(
    {
      content: [{ type: 'text', text: 'results' }],
      details: {
        query: 'mapping probe',
        results,
        fusion: { backends: ['duckduckgo'] },
        northstar: {
          schema: 'pi-northstar.result',
          version: 1,
          status,
          request: { tool: 'web_search', channel: 'web', action: 'search' },
          data: { kind: 'entities', entities: [] },
          pagination: { supported: false, limit: 8, returned: 0, hasMore: false },
          sources: [],
          errors,
          notes: [],
        },
      },
    },
    ctx(),
  );

  const success = mapped('ok', [], [hit]);
  assert.equal(success.outcome, 'success');
  assert.equal(success.error, undefined);
  assert.equal((success.data as { results: unknown[] }).results.length, 1);
  assert.equal(validateCommandResult(success).ok, true);

  const empty = mapped('empty', [], []);
  assert.equal(empty.outcome, 'empty');
  assert.equal(empty.error, undefined, 'ordinary empty invents no error');
  assert.notEqual(empty.data, null);
  assert.equal(validateCommandResult(empty).ok, true);

  const partial = mapped('partial', [{ code: 'backend_http_error', message: 'brave degraded', retryable: false }], [hit]);
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.error?.code, 'backend_http_error');
  assert.equal(partial.error?.retryable, false);
  assert.equal(partial.retryability, 'not_retryable');
  assert.equal((partial.data as { results: unknown[] }).results.length, 1, 'partial retains hits');
  assert.equal(validateCommandResult(partial).ok, true);

  const degraded = mapped('degraded', [{ code: 'timeout', message: 'slow sibling', retryable: true }], [hit]);
  assert.equal(degraded.outcome, 'degraded');
  assert.equal(degraded.error?.code, 'timeout');
  assert.equal(degraded.error?.retryable, true, 'retryability follows the authoritative retryable bit');
  assert.equal(degraded.retryability, 'retryable');
  assert.equal((degraded.data as { results: unknown[] }).results.length, 1, 'degraded retains hits');
  assert.equal(validateCommandResult(degraded).ok, true);

  const failed = mapped('error', [{ code: 'backend_http_error', message: 'boom', retryable: false }], []);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error?.code, 'backend_http_error');
  assert.equal(failed.error?.message, 'boom');
  assert.equal(failed.data, null, 'failed outcome carries no data');
  assert.equal(validateCommandResult(failed).ok, true);
});
