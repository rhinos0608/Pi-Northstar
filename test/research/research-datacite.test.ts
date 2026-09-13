import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchDatacite } from '../../src/research/research-datacite.js';
import { decodeResultCursor, encodeResultCursor, validateNorthstarResult } from '../../src/result-contract.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SUCCESS_BODY = {
  data: [
    {
      id: '10.1234/example',
      type: 'dois',
      attributes: {
        doi: '10.1234/example',
        titles: [{ title: 'Example dataset' }],
        creators: [{ name: 'Ada Example' }, { name: 'Bob Example' }],
        publisher: 'Example Publisher',
        publicationYear: 2016,
        url: 'https://example.org/dataset',
      },
    },
    { type: 'dois', attributes: {} }, // malformed row
  ],
  meta: { total: 2, totalPages: 1 },
  links: { self: 'https://api.datacite.org/dois?page%5Bcursor%5D=1', next: 'https://api.datacite.org/dois?page%5Bcursor%5D=TOKEN2' },
};

test('datacite: fielded query filters, page[cursor] paging, entity mapping, cursor token', async () => {
  const urls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    return jsonResponse(SUCCESS_BODY);
  };
  try {
    const result = await searchDatacite(
      { query: 'machine learning', limit: 10, yearFrom: 2015, author: 'Ada Example', doi: '10.1234/other', env: {} },
      { requestedAction: 'search' },
    );
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]!);
    assert.equal(url.origin + url.pathname, 'https://api.datacite.org/dois');
    assert.equal(
      url.searchParams.get('query'),
      'machine learning AND publicationYear:[2015 TO *] AND creators.name:"Ada Example" AND doi:"10.1234/other"',
    );
    assert.equal(url.searchParams.get('page[size]'), '10');
    assert.equal(url.searchParams.get('page[cursor]'), '1'); // documented start token

    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'partial'); // one malformed row among valid ones
    assert.equal(result.errors.some((error) => error.code === 'invalid_entity'), true);
    if (result.data.kind !== 'entities') return;
    const first = result.data.entities[0]!;
    assert.equal(first.kind, 'work');
    assert.equal(first.id, '10.1234/example');
    assert.equal(first.doi, '10.1234/example');
    assert.equal(first.url, 'https://doi.org/10.1234/example');
    assert.equal(first.title, 'Example dataset');
    assert.equal(first.year, 2016);
    assert.deepEqual(first.authors, [{ name: 'Ada Example' }, { name: 'Bob Example' }]);
    assert.ok(!('publisher' in first)); // no raw provider object leakage

    assert.equal(result.pagination.hasMore, true);
    const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'datacite', query: 'machine learning', yearFrom: 2015 });
    assert.equal(decoded.state.cursor, 'TOKEN2');

    // Continuation keeps only the token, never the provider URL.
    await searchDatacite({ query: 'machine learning', limit: 10, yearFrom: 2015, cursor: result.pagination.nextCursor!, env: {} });
    assert.equal(new URL(urls[1]!).searchParams.get('page[cursor]'), 'TOKEN2');
    assert.doesNotMatch(JSON.stringify(result), /datacite\.org\/dois\?/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('datacite: bare query → default start cursor, no venue filter accepted', async () => {
  const savedFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    return jsonResponse({ data: [], meta: {} });
  };
  try {
    const result = await searchDatacite({ query: 'q', env: {} });
    assert.equal(new URL(urls[0]!).searchParams.get('page[cursor]'), '1');
    assert.equal(result.status, 'empty');

    const rejected = await searchDatacite({ query: 'q', venue: 'Example Journal', env: {} });
    assert.equal(rejected.errors[0]?.code, 'invalid_input');
    assert.match(rejected.errors[0]?.message ?? '', /venue/);
    assert.equal(urls.length, 1);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('datacite: malformed HTTP 200 → invalid_backend_response', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ meta: { total: 5 } });
  try {
    const result = await searchDatacite({ query: 'q', env: {} });
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
    assert.ok(validateNorthstarResult(result).ok);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('datacite: HTTP 429 → rate_limited retryable', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  try {
    const result = await searchDatacite({ query: 'q', env: {} });
    assert.equal(result.errors[0]?.code, 'rate_limited');
    assert.equal(result.errors[0]?.retryable, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('datacite: cursor bound to query — changed query invalidates cursor', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ data: [], meta: {} });
  try {
    const first = await searchDatacite({ query: 'alpha', env: {} });
    const cursor = encodeResultCursor({ source: 'datacite', query: 'q', state: { cursor: 'T9' } });
    const moved = await searchDatacite({ query: 'different query', cursor, env: {} });
    assert.equal(moved.errors[0]?.code, 'invalid_input');
    assert.match(moved.errors[0]?.message ?? '', /does not match/);
    void first;
  } finally {
    globalThis.fetch = savedFetch;
  }
});
