import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HACKERNEWS_BACKEND, HACKERNEWS_ENDPOINT, searchHackerNews } from '../../src/research/research-hackernews.js';
import { decodeResultCursor, encodeResultCursor, validateNorthstarResult } from '../../src/result-contract.js';

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

function hit(index: number): Record<string, unknown> {
  return {
    objectID: String(40_000_000 + index),
    title: `Story ${index}`,
    url: `https://example.com/story-${index}`,
    author: `user${index}`,
    points: index * 10,
    num_comments: index,
    created_at: '2024-01-01T00:00:00Z',
    story_text: `Text ${index}`,
  };
}

function hitsPage(count: number, nbPages: number): Record<string, unknown> {
  return { hits: Array.from({ length: count }, (_, index) => hit(index + 1)), nbPages, page: 0 };
}

test('searchHackerNews maps valid hits and hits the fixed official host', async () => {
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse(hitsPage(2, 1));
  }, () => searchHackerNews({ query: 'rust', env: {} }));
  const url = new URL(captured);
  assert.equal(url.origin + url.pathname, HACKERNEWS_ENDPOINT);
  assert.equal(url.searchParams.get('query'), 'rust');
  assert.equal(url.searchParams.get('tags'), 'story');
  assert.equal(url.searchParams.get('hitsPerPage'), '10');
  assert.equal(url.searchParams.get('page'), '0');
  assert.ok(validateNorthstarResult(result).ok, JSON.stringify(validateNorthstarResult(result).issues));
  assert.equal(result.status, 'ok');
  assert.equal(result.sources[0]?.backend, HACKERNEWS_BACKEND);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  const entity = result.data.entities[0]!;
  assert.equal(entity.kind, 'article');
  assert.equal(entity.source, 'hackernews');
  assert.equal(entity.id, '40000001');
  assert.equal(entity.url, 'https://example.com/story-1');
  assert.equal(entity.title, 'Story 1');
  assert.equal(entity.snippet, 'Text 1');
  assert.deepEqual(entity.authors, [{ name: 'user1' }]);
  assert.equal(entity.publishedAt, '2024-01-01T00:00:00Z');
  assert.deepEqual(entity.metrics, { score: 10, comments: 1 });
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
});

test('searchHackerNews falls back to the item URL for url-less hits', async () => {
  const row = hit(9);
  delete row.url;
  const result = await withFetch(
    async () => jsonResponse({ hits: [row], nbPages: 1 }),
    () => searchHackerNews({ query: 'q', env: {} }),
  );
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities[0]?.url, 'https://news.ycombinator.com/item?id=40000009');
});

test('searchHackerNews applies the created_at_i numeric filter for yearFrom', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ hits: [], nbPages: 0 });
  }, () => searchHackerNews({ query: 'q', yearFrom: 2023, env: {} }));
  // 2023-01-01T00:00:00Z in epoch seconds.
  assert.equal(new URL(captured).searchParams.get('numericFilters'), 'created_at_i>=1672531200');
});

test('searchHackerNews malformed HTTP-200 container → invalid_backend_response', async () => {
  for (const payload of [{}, { nbPages: 4 }, [1, 2, 3], 'ok']) {
    const result = await withFetch(async () => jsonResponse(payload), () => searchHackerNews({ query: 'q', env: {} }));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
    assert.match(result.errors[0]?.message ?? '', /missing hits array/);
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.nextCursor, undefined);
    assert.ok(validateNorthstarResult(result).ok);
  }
});

test('searchHackerNews drops id-less hits as invalid_entity with partial status', async () => {
  const result = await withFetch(
    async () => jsonResponse({ hits: [hit(1), { title: 'no id' }, null], nbPages: 1 }),
    () => searchHackerNews({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'partial');
  const invalid = result.errors.filter((error) => error.code === 'invalid_entity');
  assert.equal(invalid.length, 1);
  assert.match(invalid[0]!.message, /Dropped 2 malformed row\(s\) from hackernews\./);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities.length, 1);
  assert.equal(result.pagination.hasMore, false);
});

test('searchHackerNews all-malformed page is an error with no hasMore or cursor', async () => {
  // Regression: nbPages promises more pages, but a zero-valid-entity page must
  // not advertise a continuation (infinite zero-result paging).
  const result = await withFetch(
    async () => jsonResponse({ hits: [{ title: 'a' }, '', 7], nbPages: 5 }),
    () => searchHackerNews({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'error');
  assert.ok(result.errors.some((error) => error.code === 'invalid_entity'));
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities.length, 0);
});

test('searchHackerNews cursor round-trip: page advances and binds to query', async () => {
  const first = await withFetch(
    async () => jsonResponse(hitsPage(10, 3)),
    () => searchHackerNews({ query: 'q', env: {} }),
  );
  assert.equal(first.pagination.hasMore, true);
  const decoded = decodeResultCursor(first.pagination.nextCursor!, { source: 'hackernews', query: 'q' });
  assert.equal(decoded.state.page, 1);

  let captured = '';
  const second = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ ...hitsPage(10, 3), page: 1 });
  }, () => searchHackerNews({ query: 'q', cursor: first.pagination.nextCursor!, env: {} }));
  assert.equal(new URL(captured).searchParams.get('page'), '1');
  assert.equal(second.pagination.hasMore, true);
  const decoded2 = decodeResultCursor(second.pagination.nextCursor!, { source: 'hackernews', query: 'q' });
  assert.equal(decoded2.state.page, 2);

  // A cursor issued for another query is rejected without fetching.
  const other = encodeResultCursor({ source: 'hackernews', query: 'different', state: { page: 1 } });
  const moved = await withFetch(
    async () => { throw new Error('should not fetch'); },
    () => searchHackerNews({ query: 'q', cursor: other, env: {} }),
  );
  assert.equal(moved.errors[0]?.code, 'invalid_input');
  assert.match(moved.errors[0]?.message ?? '', /does not match/);
});

test('searchHackerNews last page reports hasMore=false with no cursor', async () => {
  const cursor = encodeResultCursor({ source: 'hackernews', query: 'q', state: { page: 1 } });
  const result = await withFetch(
    async () => jsonResponse({ ...hitsPage(10, 2), page: 1 }),
    () => searchHackerNews({ query: 'q', cursor, env: {} }),
  );
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
});

test('searchHackerNews zero-result page is empty with no continuation', async () => {
  const result = await withFetch(
    async () => jsonResponse({ hits: [], nbPages: 0 }),
    () => searchHackerNews({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
});
