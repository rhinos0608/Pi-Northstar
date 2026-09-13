import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CROSSREF_BACKEND, CROSSREF_ENDPOINT, searchCrossref } from '../../src/research/research-crossref.js';
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

function work(index: number): Record<string, unknown> {
  return {
    DOI: `10.1234/paper-${index}`,
    URL: `https://publisher.example/paper-${index}`,
    title: [`Paper ${index}`],
    author: [{ given: 'Ada', family: 'Lovelace' }],
    issued: { 'date-parts': [[2020 + index]] },
    'container-title': ['Journal of Examples'],
    'is-referenced-by-count': index * 5,
    abstract: `Abstract ${index}`,
  };
}

function itemsPage(count: number, total = 10_000): Record<string, unknown> {
  return { status: 'ok', message: { 'total-results': total, items: Array.from({ length: count }, (_, index) => work(index + 1)) } };
}

test('searchCrossref maps valid items and hits the fixed official host', async () => {
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse(itemsPage(2));
  }, () => searchCrossref({ query: 'protein folding', env: {} }));
  const url = new URL(captured);
  assert.equal(url.origin + url.pathname, CROSSREF_ENDPOINT);
  assert.equal(url.searchParams.get('query'), 'protein folding');
  assert.equal(url.searchParams.get('rows'), '10');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.ok(url.searchParams.get('select')?.includes('DOI'));
  assert.ok(validateNorthstarResult(result).ok, JSON.stringify(validateNorthstarResult(result).issues));
  assert.equal(result.status, 'ok');
  assert.equal(result.sources[0]?.backend, CROSSREF_BACKEND);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  const entity = result.data.entities[0]!;
  assert.equal(entity.kind, 'work');
  assert.equal(entity.source, 'crossref');
  assert.equal(entity.id, '10.1234/paper-1');
  assert.equal(entity.url, 'https://publisher.example/paper-1'); // provider URL preferred
  assert.equal(entity.title, 'Paper 1');
  assert.equal(entity.snippet, 'Abstract 1');
  assert.deepEqual(entity.authors, [{ name: 'Ada Lovelace' }]);
  assert.equal(entity.year, 2021);
  assert.equal(entity.venue, 'Journal of Examples');
  assert.equal(entity.doi, '10.1234/paper-1');
  assert.deepEqual(entity.metrics, { citations: 5 });
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
});

test('searchCrossref DOI-only rows fall back to the canonical doi.org link', async () => {
  const row = work(7);
  delete row.URL;
  const result = await withFetch(
    async () => jsonResponse({ message: { items: [row] } }),
    () => searchCrossref({ query: 'q', env: {} }),
  );
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities[0]?.url, 'https://doi.org/10.1234/paper-7');
});

test('searchCrossref applies the from-pub-date filter and query.author for yearFrom/author', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ message: { items: [] } });
  }, () => searchCrossref({ query: 'q', yearFrom: 2021, author: 'Lovelace', env: {} }));
  const url = new URL(captured);
  assert.equal(url.searchParams.get('filter'), 'from-pub-date:2021-01-01');
  assert.equal(url.searchParams.get('query.author'), 'Lovelace');
});

test('searchCrossref malformed HTTP-200 container → invalid_backend_response', async () => {
  for (const payload of [{}, { message: {} }, { message: { items: 'nope' } }, [1, 2]]) {
    const result = await withFetch(async () => jsonResponse(payload), () => searchCrossref({ query: 'q', env: {} }));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
    assert.match(result.errors[0]?.message ?? '', /missing message\.items/);
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.nextCursor, undefined);
    assert.ok(validateNorthstarResult(result).ok);
  }
});

test('searchCrossref malformed-row accounting: dropped rows counted, valid sibling survives', async () => {
  const result = await withFetch(
    async () => jsonResponse({ message: { items: [work(1), {}, null, { title: ['no doi or url'] }] } }),
    () => searchCrossref({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'partial');
  const invalid = result.errors.filter((error) => error.code === 'invalid_entity');
  assert.equal(invalid.length, 1);
  // Exact accounting: 3 malformed rows of 4 returned.
  assert.match(invalid[0]!.message, /Dropped 3 malformed row\(s\) from crossref\./);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities.length, 1);
  assert.equal(result.data.entities[0]?.id, '10.1234/paper-1');
  // Fewer valid entities than the requested limit → no continuation advertised.
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
});

test('searchCrossref cursor round-trip: offset advances by limit and binds to query', async () => {
  const first = await withFetch(
    async () => jsonResponse(itemsPage(10)),
    () => searchCrossref({ query: 'q', env: {} }),
  );
  assert.equal(first.pagination.hasMore, true);
  const decoded = decodeResultCursor(first.pagination.nextCursor!, { source: 'crossref', query: 'q' });
  assert.equal(decoded.state.offset, 10);

  let captured = '';
  const second = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse(itemsPage(10));
  }, () => searchCrossref({ query: 'q', cursor: first.pagination.nextCursor!, env: {} }));
  assert.equal(new URL(captured).searchParams.get('offset'), '10');
  assert.equal(second.pagination.hasMore, true);
  const decoded2 = decodeResultCursor(second.pagination.nextCursor!, { source: 'crossref', query: 'q' });
  assert.equal(decoded2.state.offset, 20);

  // A cursor issued for another query is rejected without fetching.
  const other = encodeResultCursor({ source: 'crossref', query: 'different', state: { offset: 10 } });
  const moved = await withFetch(
    async () => { throw new Error('should not fetch'); },
    () => searchCrossref({ query: 'q', cursor: other, env: {} }),
  );
  assert.equal(moved.errors[0]?.code, 'invalid_input');
  assert.match(moved.errors[0]?.message ?? '', /does not match/);
});

test('searchCrossref zero-result page is empty with no continuation', async () => {
  const result = await withFetch(
    async () => jsonResponse({ message: { 'total-results': 0, items: [] } }),
    () => searchCrossref({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
  assert.ok(validateNorthstarResult(result).ok);
});
