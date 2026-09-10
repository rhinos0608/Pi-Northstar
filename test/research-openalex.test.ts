import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchOpenAlex } from '../src/research-openalex.js';
import { decodeResultCursor, validateNorthstarResult } from '../src/result-contract.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('openalex: works search with cursor paging, bearer auth, entity mapping', async () => {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init ?? {});
    return new Response(JSON.stringify({
      meta: { count: 42, next_cursor: 'IopXcm1jdg==' },
      results: [
        {
          id: 'https://openalex.org/W123',
          doi: 'https://doi.org/10.1234/oa',
          display_name: 'OpenAlex work',
          publication_year: 2024,
          authorships: [{ author: { id: 'https://openalex.org/A9', display_name: 'Grace Hopper' } }],
          primary_location: { source: { display_name: 'OA Journal' } },
          cited_by_count: 7,
        },
        { id: 'https://openalex.org/W124', display_name: 'no doi' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await searchOpenAlex(
      { query: 'quantum error correction', limit: 5, env: { OPENALEX_API_KEY: 'oa-secret-1' } },
      { requestedAction: 'search' },
    );
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]!);
    assert.equal(url.origin + url.pathname, 'https://api.openalex.org/works');
    assert.equal(url.searchParams.get('search'), 'quantum error correction');
    assert.equal(url.searchParams.get('per_page'), '5');
    assert.equal(url.searchParams.get('cursor'), '*');
    assert.equal((inits[0]?.headers as Record<string, string>).Authorization, 'Bearer oa-secret-1');

    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'ok');
    assert.equal(result.sources[0]?.backend, 'openalex-api');
    if (result.data.kind !== 'entities') return;
    const first = result.data.entities[0]!;
    assert.equal(first.id, 'https://openalex.org/W123');
    assert.equal(first.kind, 'work');
    assert.equal(first.doi, '10.1234/oa');
    assert.equal(first.url, 'https://doi.org/10.1234/oa');
    assert.deepEqual(first.authors, [{ name: 'Grace Hopper', id: 'A9' }]);
    assert.equal(first.venue, 'OA Journal');
    assert.equal(first.metrics?.citations, 7);
    assert.equal(result.data.entities[1]?.url, 'https://openalex.org/W124');

    assert.equal(result.pagination.hasMore, true);
    const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'openalex', query: 'quantum error correction' });
    assert.equal(decoded.state.cursor, 'IopXcm1jdg==');

    // Continuation: next call passes the cursor through to OpenAlex.
    await searchOpenAlex({ query: 'quantum error correction', limit: 5, cursor: result.pagination.nextCursor!, env: {} });
    assert.equal(new URL(urls[1]!).searchParams.get('cursor'), 'IopXcm1jdg==');
    assert.doesNotMatch(JSON.stringify(result), /oa-secret-1/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('openalex: author filter resolves author id via /authors then filters works', async () => {
  const urls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    if (String(input).includes('/authors?')) {
      return jsonResponse({ results: [{ id: 'https://openalex.org/A5089' }] });
    }
    return jsonResponse({ meta: {}, results: [{ id: 'https://openalex.org/W1', display_name: 'W' }] });
  };
  try {
    const result = await searchOpenAlex({ query: 'compilers', author: 'Grace Hopper', env: {} });
    assert.equal(urls.length, 2);
    const worksUrl = new URL(urls[1]!);
    assert.equal(worksUrl.searchParams.get('filter'), 'authorships.author.id:A5089');
    assert.equal(result.status, 'ok');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('openalex: author filter with no resolution match → empty result with note', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ results: [] });
  try {
    const result = await searchOpenAlex({ query: 'compilers', author: 'Nobody Real', env: {} });
    assert.equal(result.status, 'empty');
    assert.equal(result.errors.length, 0);
    assert.equal(result.notes.length, 1);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('openalex: malformed HTTP 200 → invalid_backend_response', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ meta: { count: 3 } });
  try {
    const result = await searchOpenAlex({ query: 'q', env: {} });
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
    assert.ok(validateNorthstarResult(result).ok);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('openalex: HTTP 429 → rate_limited; key never leaks', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  try {
    const result = await searchOpenAlex({ query: 'q', env: { OPENALEX_API_KEY: 'oa-secret-1' } });
    assert.equal(result.errors[0]?.code, 'rate_limited');
    assert.equal(result.errors[0]?.retryable, true);
    assert.doesNotMatch(JSON.stringify(result), /oa-secret-1/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
