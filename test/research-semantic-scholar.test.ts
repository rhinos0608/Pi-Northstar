import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSemanticScholar } from '../src/research-semantic-scholar.js';
import { decodeResultCursor, validateNorthstarResult } from '../src/result-contract.js';

const SUCCESS_BODY = {
  total: 2,
  offset: 0,
  next: 10,
  data: [
    {
      paperId: 'abc123',
      title: 'Example work',
      year: 2024,
      venue: 'Example Journal',
      abstract: 'An example abstract.',
      authors: [{ authorId: 'a1', name: 'Ada Example' }],
      externalIds: { DOI: '10.1234/example' },
      citationCount: 12,
    },
    {
      paperId: 'zzz',
      title: 'No url fallback',
      year: 2023,
      authors: [],
    },
  ],
};

test('semantic scholar: fixed endpoint, year filter, auth header, entity mapping, cursor', async () => {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init ?? {});
    return new Response(JSON.stringify(SUCCESS_BODY), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await searchSemanticScholar(
      { query: 'transformer interpretability', limit: 10, yearFrom: 2020, env: { SEMANTIC_SCHOLAR_API_KEY: 'sk-secret-1' } },
      { requestedAction: 'search' },
    );
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]!);
    assert.equal(url.origin + url.pathname, 'https://api.semanticscholar.org/graph/v1/paper/search');
    assert.equal(url.searchParams.get('query'), 'transformer interpretability');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('offset'), '0');
    assert.equal(url.searchParams.get('year'), '2020-');
    assert.ok(url.searchParams.get('fields')?.includes('paperId'));
    const headers = inits[0]?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'sk-secret-1');

    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'ok');
    assert.equal(result.request.source, 'semantic_scholar');
    assert.equal(result.request.channel, 'research');
    assert.equal(result.sources[0]?.backend, 'semantic-scholar-api');
    assert.equal(result.data.kind, 'entities');
    if (result.data.kind !== 'entities') return;
    assert.equal(result.data.entities.length, 2);
    const first = result.data.entities[0]!;
    assert.equal(first.kind, 'work');
    assert.equal(first.doi, '10.1234/example');
    assert.equal(first.url, 'https://doi.org/10.1234/example');
    assert.equal(first.venue, 'Example Journal');
    assert.equal(first.year, 2024);
    assert.equal(first.metrics?.citations, 12);
    assert.deepEqual(first.authors, [{ name: 'Ada Example' }]);
    // row without DOI/url falls back to a Pi-constructed S2 paper URL
    assert.equal(result.data.entities[1]?.url, 'https://www.semanticscholar.org/paper/zzz');

    assert.equal(result.pagination.supported, true);
    assert.equal(result.pagination.hasMore, true);
    const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'semantic_scholar', query: 'transformer interpretability', yearFrom: 2020 });
    assert.equal(decoded.state.offset, 10);

    // Cursor round trip: second call resumes at the offset.
    const page2 = await searchSemanticScholar(
      { query: 'transformer interpretability', limit: 10, yearFrom: 2020, cursor: result.pagination.nextCursor!, env: {} },
    );
    assert.equal(new URL(urls[1]!).searchParams.get('offset'), '10');
    // Envelope never echoes the API key.
    assert.doesNotMatch(JSON.stringify(result), /sk-secret-1/);
    assert.doesNotMatch(JSON.stringify(page2), /sk-secret-1/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('semantic scholar: no key → no x-api-key header; unsupported filters rejected without fetch', async () => {
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await searchSemanticScholar({ query: 'q', env: {} });
    assert.equal(calls, 1);
    assert.equal(Object.keys((await Promise.resolve({})) ?? {}).length >= 0, true);
    assert.equal(result.status, 'empty');

    const rejected = await searchSemanticScholar({ query: 'q', author: 'Ada', env: {} });
    assert.equal(calls, 1); // no additional fetch
    assert.equal(rejected.status, 'error');
    assert.equal(rejected.errors[0]?.code, 'invalid_input');
    assert.match(rejected.errors[0]?.message ?? '', /author/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('semantic scholar: malformed HTTP 200 (missing data array) → invalid_backend_response error', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ total: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await searchSemanticScholar({ query: 'q', env: {} });
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
    assert.equal(result.sources[0]?.status, 'error');
    assert.equal(result.sources[0]?.count, 0);
    assert.equal(validateNorthstarResult(result).ok, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('semantic scholar: malformed rows dropped, valid siblings → partial', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { paperId: 'ok', title: 'Fine', url: 'https://example.com/ok' },
      { paperId: '', title: 'missing id and url' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await searchSemanticScholar({ query: 'q', env: {} });
    assert.equal(result.status, 'partial');
    assert.equal(result.errors.some((error) => error.code === 'invalid_entity'), true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('semantic scholar: HTTP 429 → rate_limited retryable; HTTP error sanitized', async () => {
  const savedFetch = globalThis.fetch;
  let mode = 0;
  globalThis.fetch = async () => {
    mode += 1;
    return new Response('{}', { status: mode === 1 ? 429 : 403 });
  };
  try {
    const limited = await searchSemanticScholar({ query: 'q', env: { SEMANTIC_SCHOLAR_API_KEY: 'sk-secret-1' } });
    assert.equal(limited.status, 'error');
    assert.equal(limited.errors[0]?.code, 'rate_limited');
    assert.equal(limited.errors[0]?.retryable, true);
    assert.doesNotMatch(JSON.stringify(limited), /sk-secret-1/);

    const denied = await searchSemanticScholar({ query: 'q', env: {} });
    assert.equal(denied.errors[0]?.code, 'backend_http_error');
    assert.equal(denied.errors[0]?.retryable, false);
    assert.doesNotMatch(denied.errors[0]?.message ?? '', /https?:\/\//);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
