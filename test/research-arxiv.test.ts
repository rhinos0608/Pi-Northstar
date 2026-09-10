import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARXIV_BACKEND, ARXIV_ENDPOINT, searchArxiv } from '../src/research-arxiv.js';
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

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/atom+xml; charset=utf-8' } });
}

function entry(index: number): string {
  return `<entry>
  <id>http://arxiv.org/abs/2401.0000${index}v1</id>
  <title>Paper ${index}</title>
  <summary>Summary ${index}</summary>
  <author><name>Author ${index}</name></author>
  <published>2024-01-0${index}T00:00:00Z</published>
</entry>`;
}

function feed(total: number, entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${total}</opensearch:totalResults>
  ${entries.join('\n')}
</feed>`;
}

test('searchArxiv maps a valid Atom feed and hits the fixed official host', async () => {
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return xmlResponse(feed(2, [entry(1), entry(2)]));
  }, () => searchArxiv({ query: 'quantum', env: {} }));
  const url = new URL(captured);
  assert.equal(url.origin + url.pathname, ARXIV_ENDPOINT);
  assert.equal(url.searchParams.get('search_query'), 'all:quantum');
  assert.equal(url.searchParams.get('start'), '0');
  assert.equal(url.searchParams.get('max_results'), '10');
  assert.ok(validateNorthstarResult(result).ok, JSON.stringify(validateNorthstarResult(result).issues));
  assert.equal(result.status, 'ok');
  assert.equal(result.sources[0]?.backend, ARXIV_BACKEND);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  const entity = result.data.entities[0]!;
  assert.equal(entity.kind, 'work');
  assert.equal(entity.source, 'arxiv');
  assert.equal(entity.id, 'http://arxiv.org/abs/2401.00001v1');
  assert.equal(entity.url, 'http://arxiv.org/abs/2401.00001v1');
  assert.equal(entity.title, 'Paper 1');
  assert.equal(entity.snippet, 'Summary 1');
  assert.deepEqual(entity.authors, [{ name: 'Author 1' }]);
  assert.equal(entity.year, 2024);
  assert.equal(entity.publishedAt, '2024-01-01T00:00:00Z');
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
});

test('searchArxiv malformed HTTP-200 container → invalid_backend_response, never empty success', async () => {
  for (const body of ['gateway timeout, try again', '<html><body>maintenance</body></html>', feed(5, [entry(1)]).replace(/opensearch:totalResults[^>]*>\d+</, 'opensearch:totalResults>-<')]) {
    const result = await withFetch(async () => xmlResponse(body), () => searchArxiv({ query: 'q', env: {} }));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
    assert.match(result.errors[0]?.message ?? '', /not a valid Atom feed/);
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.nextCursor, undefined);
    assert.ok(validateNorthstarResult(result).ok);
  }
});

test('searchArxiv drops id-less entries as invalid_entity with partial status', async () => {
  const result = await withFetch(
    async () => xmlResponse(feed(3, [entry(1), '<entry><title>orphan</title></entry>'])),
    () => searchArxiv({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'partial');
  const invalid = result.errors.filter((error) => error.code === 'invalid_entity');
  assert.equal(invalid.length, 1);
  assert.match(invalid[0]!.message, /Dropped 1 malformed row\(s\) from arxiv\./);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities.length, 1);
  // Continuation advances by the raw page size, malformed rows included.
  assert.equal(result.pagination.hasMore, true);
  const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'arxiv', query: 'q' });
  assert.equal(decoded.state.offset, 1);
});

test('searchArxiv all-malformed page is an error with no hasMore or cursor', async () => {
  const result = await withFetch(
    async () => xmlResponse(feed(2, ['<entry><title>a</title></entry>', '<entry><summary>b</summary></entry>'])),
    () => searchArxiv({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'error');
  assert.ok(result.errors.some((error) => error.code === 'invalid_entity'));
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities.length, 0);
});

test('searchArxiv cursor round-trip: offset advances by page size and binds to query', async () => {
  const page = Array.from({ length: 10 }, (_, index) => entry(index + 1));
  const first = await withFetch(
    async () => xmlResponse(feed(25, page)),
    () => searchArxiv({ query: 'q', env: {} }),
  );
  assert.equal(first.pagination.hasMore, true);
  const decoded = decodeResultCursor(first.pagination.nextCursor!, { source: 'arxiv', query: 'q' });
  assert.equal(decoded.state.offset, 10);

  let captured = '';
  const second = await withFetch(async (input) => {
    captured = String(input);
    return xmlResponse(feed(25, page));
  }, () => searchArxiv({ query: 'q', cursor: first.pagination.nextCursor!, env: {} }));
  assert.equal(new URL(captured).searchParams.get('start'), '10');
  assert.equal(second.pagination.hasMore, true);
  const decoded2 = decodeResultCursor(second.pagination.nextCursor!, { source: 'arxiv', query: 'q' });
  assert.equal(decoded2.state.offset, 20);

  // A cursor issued for another query is rejected without fetching.
  const other = encodeResultCursor({ source: 'arxiv', query: 'different', state: { offset: 10 } });
  const moved = await withFetch(
    async () => { throw new Error('should not fetch'); },
    () => searchArxiv({ query: 'q', cursor: other, env: {} }),
  );
  assert.equal(moved.errors[0]?.code, 'invalid_input');
  assert.match(moved.errors[0]?.message ?? '', /does not match/);
});

test('searchArxiv zero-result feed is empty with no continuation', async () => {
  const result = await withFetch(
    async () => xmlResponse(feed(0, [])),
    () => searchArxiv({ query: 'q', env: {} }),
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
  assert.ok(validateNorthstarResult(result).ok);
});

test('searchArxiv applies the submittedDate range for yearFrom', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return xmlResponse(feed(0, []));
  }, () => searchArxiv({ query: 'q', yearFrom: 2023, env: {} }));
  assert.equal(
    new URL(captured).searchParams.get('search_query'),
    'all:q AND submittedDate:[202301010000 TO 999912312359]',
  );
});
