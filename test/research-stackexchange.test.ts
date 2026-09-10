import assert from 'node:assert/strict';
import { test } from 'node:test';
import { researchSourceCapability } from '../src/capabilities.js';
import {
  STACK_EXCHANGE_BACKEND,
  STACK_EXCHANGE_ENDPOINT,
  STACK_EXCHANGE_MAX_PAGE,
  STACK_EXCHANGE_SOURCE,
  searchStackExchange,
} from '../src/research-stackexchange.js';
import { decodeResultCursor, encodeResultCursor, validateNorthstarResult } from '../src/result-contract.js';

async function withFetch<T>(impl: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = saved;
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function statusResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

function excerptItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question_id: 12345678,
    title: 'How to <b>use</b> generics?',
    excerpt: 'I want <span class="matched-term">generics</span> help &amp; tips',
    creation_date: 1700000000,
    score: 42,
    ...overrides,
  };
}

test('searchStackExchange builds the official excerpts URL with site, q, pagesize, and optional key', async () => {
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ items: [], has_more: false });
  }, () => searchStackExchange(
    { query: 'typescript generics', limit: 5, env: { STACKEXCHANGE_KEY: 'se-app-key-123' } },
  ));
  assert.equal(result.status, 'empty');
  const url = new URL(captured);
  assert.equal(url.origin + url.pathname, STACK_EXCHANGE_ENDPOINT);
  assert.equal(url.host, 'api.stackexchange.com');
  assert.equal(url.searchParams.get('site'), 'stackoverflow');
  assert.equal(url.searchParams.get('q'), 'typescript generics');
  assert.equal(url.searchParams.get('pagesize'), '5');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('key'), 'se-app-key-123');
});

test('searchStackExchange sends no key without STACKEXCHANGE_KEY', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ items: [], has_more: false });
  }, () => searchStackExchange({ query: 'q' }));
  assert.equal(new URL(captured).searchParams.get('key'), null);
});

test('searchStackExchange maps excerpt rows to question entities', async () => {
  const result = await withFetch(
    async () => jsonResponse({ items: [excerptItem()], has_more: false }),
    () => searchStackExchange({ query: 'generics' }),
  );
  assert.equal(result.status, 'ok');
  assert.ok(validateNorthstarResult(result).ok, JSON.stringify(validateNorthstarResult(result).issues));
  assert.equal(result.data.kind, 'entities');
  if (result.data.kind !== 'entities') return;
  const entity = result.data.entities[0]!;
  assert.equal(entity.kind, 'question');
  assert.equal(entity.source, 'stackoverflow');
  assert.equal(entity.id, '12345678');
  assert.equal(entity.url, 'https://stackoverflow.com/q/12345678');
  assert.equal(entity.title, 'How to use generics?');
  assert.equal(entity.snippet, 'I want generics help & tips');
  assert.equal(entity.publishedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(entity.year, 2023);
  assert.equal(entity.metrics?.score, 42);
  assert.equal(result.sources[0]?.backend, STACK_EXCHANGE_BACKEND);
  assert.equal(result.sources[0]?.count, 1);
  assert.equal(result.request.tool, 'web_search');
  assert.equal(result.request.channel, 'research');
  assert.equal(result.request.source, STACK_EXCHANGE_SOURCE);
});

test('searchStackExchange backend matches the capability registry', () => {
  const capability = researchSourceCapability('stackoverflow');
  assert.ok(capability);
  assert.equal(capability.backend, STACK_EXCHANGE_BACKEND);
  assert.equal(capability.entityKind, 'question');
  assert.equal(capability.pagination, 'page');
  assert.equal(researchSourceCapability('stackoverflow')?.yearFilter, 'supported');
});

test('searchStackExchange converts yearFrom to a unix fromdate filter', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ items: [], has_more: false });
  }, () => searchStackExchange({ query: 'q', yearFrom: 2024 }));
  assert.equal(new URL(captured).searchParams.get('fromdate'), String(Date.UTC(2024, 0, 1) / 1000));
});

test('searchStackExchange emits a page cursor when has_more', async () => {
  const first = await withFetch(
    async () => jsonResponse({ items: [excerptItem()], has_more: true }),
    () => searchStackExchange({ query: 'q' }),
  );
  assert.equal(first.pagination.hasMore, true);
  assert.ok(first.pagination.nextCursor);
  const decoded = decodeResultCursor(first.pagination.nextCursor!, { source: 'stackoverflow', query: 'q' });
  assert.equal(decoded.state.page, 2);

  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ items: [], has_more: false });
  }, () => searchStackExchange({ query: 'q', cursor: first.pagination.nextCursor! }));
  assert.equal(new URL(captured).searchParams.get('page'), '2');
});

test('searchStackExchange drops malformed rows and reports invalid_entity with partial status', async () => {
  const result = await withFetch(
    async () => jsonResponse({ items: [excerptItem(), excerptItem({ question_id: 'not-a-number' }), null], has_more: false }),
    () => searchStackExchange({ query: 'q' }),
  );
  assert.equal(result.status, 'partial');
  if (result.data.kind === 'entities') assert.equal(result.data.entities.length, 1);
  assert.ok(result.errors.some((error) => error.code === 'invalid_entity'));
  assert.equal(result.sources[0]?.status, 'partial');
});

test('searchStackExchange rejects HTTP 200 payloads missing the items array', async () => {
  for (const payload of [{ quota_max: 10000 }, 'nope', null]) {
    const result = await withFetch(async () => jsonResponse(payload), () => searchStackExchange({ query: 'q' }));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
    assert.equal(result.sources[0]?.status, 'error');
  }
});

test('searchStackExchange maps HTTP 429 to rate_limited without leaking URL or key', async () => {
  const result = await withFetch(
    async () => statusResponse(429, 'rate limited'),
    () => searchStackExchange({ query: 'q', env: { STACKEXCHANGE_KEY: 'secret-key-123' } }),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0]?.code, 'rate_limited');
  assert.equal(result.errors[0]?.retryable, true);
  const message = JSON.stringify(result.errors);
  assert.doesNotMatch(message, /https?:\/\//);
  assert.ok(!message.includes('secret-key-123'));
});

test('searchStackExchange maps HTTP 500 to a retryable backend_http_error', async () => {
  const result = await withFetch(
    async () => statusResponse(500, 'boom'),
    () => searchStackExchange({ query: 'q' }),
  );
  assert.equal(result.errors[0]?.code, 'backend_http_error');
  assert.equal(result.errors[0]?.retryable, true);
});

test('searchStackExchange classifies non-JSON 200 bodies through the shared HTTP helper', async () => {
  const result = await withFetch(
    async () => new Response('<html>not json</html>', { status: 200 }),
    () => searchStackExchange({ query: 'q' }),
  );
  // The shared helper classifies JSON parse failures as backend_unavailable;
  // container schema violations (missing items array) remain invalid_backend_response.
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0]?.code, 'backend_unavailable');
});

test('searchStackExchange rejects non-integer limits and unsupported filters', async () => {
  for (const request of [{ query: 'q', limit: 2.5 }, { query: 'q', author: 'Ada' }, { query: 'q', doi: '10.1/x' }, { query: 'q', venue: 'ACM' }, { query: '   ' }]) {
    const result = await withFetch(
      async () => { throw new Error('should not fetch'); },
      () => searchStackExchange(request),
    );
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_input');
    // Stack Exchange pages results, so rejected inputs keep pagination advertised.
    assert.equal(result.pagination.supported, true);
    assert.equal(result.pagination.hasMore, false);
  }
});

test('searchStackExchange clamps bounded limits instead of rejecting them', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ items: [], has_more: false });
  }, () => searchStackExchange({ query: 'q', limit: 500 }));
  assert.equal(new URL(captured).searchParams.get('pagesize'), '30');
});

test('searchStackExchange rejects cursors bound to another query or source', async () => {
  const otherQuery = encodeResultCursor({ source: 'stackoverflow', query: 'other', state: { page: 2 } });
  const result = await withFetch(
    async () => jsonResponse({ items: [], has_more: false }),
    () => searchStackExchange({ query: 'q', cursor: otherQuery }),
  );
  assert.equal(result.errors[0]?.code, 'invalid_input');
  // Same-query decode failures keep Stack Exchange pagination advertised.
  assert.equal(result.pagination.supported, true);

  const otherSource = encodeResultCursor({ source: 'openalex', query: 'q', state: { page: 2 } });
  const cross = await withFetch(
    async () => jsonResponse({ items: [], has_more: false }),
    () => searchStackExchange({ query: 'q', cursor: otherSource }),
  );
  assert.equal(cross.errors[0]?.code, 'pagination_not_supported');
  // A foreign cursor cannot be resumed, so pagination.supported drops to false.
  assert.equal(cross.pagination.supported, false);
});

test('searchStackExchange rejects out-of-range cursor pages', async () => {
  const cursor = encodeResultCursor({ source: 'stackoverflow', query: 'q', state: { page: STACK_EXCHANGE_MAX_PAGE + 1 } });
  const result = await withFetch(
    async () => jsonResponse({ items: [], has_more: false }),
    () => searchStackExchange({ query: 'q', cursor }),
  );
  assert.equal(result.errors[0]?.code, 'invalid_input');
  assert.match(result.errors[0]?.message ?? '', /state\.page/);
});

test('searchStackExchange adds a note when the wrapper requests backoff', async () => {
  const result = await withFetch(
    async () => jsonResponse({ items: [], has_more: false, backoff: 3 }),
    () => searchStackExchange({ query: 'q' }),
  );
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0]!, /3s backoff/);
});

test('searchStackExchange propagates caller aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchStackExchange({ query: 'q', signal: controller.signal }),
    (error: Error) => error.name === 'AbortError',
  );
});
