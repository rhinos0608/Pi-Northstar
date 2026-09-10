import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchWikipedia } from '../src/research-wikipedia.js';
import { validateNorthstarResult } from '../src/result-contract.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('wikipedia: valid opensearch response maps titles/descriptions/urls', async () => {
  const urls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(init?.method ?? 'GET', 'GET');
    return jsonResponse([
      'grace hopper',
      ['Grace Hopper', 'Hopper (crater)'],
      ['American computer scientist', 'Lunar crater'],
      ['https://en.wikipedia.org/wiki/Grace_Hopper', 'https://en.wikipedia.org/wiki/Hopper_(crater)'],
    ]);
  };
  try {
    const result = await searchWikipedia({ query: 'grace hopper', limit: 2, env: {} });
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]!);
    assert.equal(url.origin + url.pathname, 'https://en.wikipedia.org/w/api.php');
    assert.equal(url.searchParams.get('action'), 'opensearch');
    assert.equal(url.searchParams.get('search'), 'grace hopper');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.get('namespace'), '0');

    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'ok');
    assert.equal(result.sources[0]?.backend, 'wikipedia-api');
    assert.equal(result.sources[0]?.status, 'ok');
    if (result.data.kind !== 'entities') return;
    assert.equal(result.data.entities.length, 2);
    const first = result.data.entities[0]!;
    assert.equal(first.kind, 'article');
    assert.equal(first.source, 'wikipedia');
    assert.equal(first.title, 'Grace Hopper');
    assert.equal(first.url, 'https://en.wikipedia.org/wiki/Grace_Hopper');
    assert.equal(first.snippet, 'American computer scientist');
    assert.equal(result.pagination.supported, false);
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.nextCursor, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikipedia: malformed container (non-array / short / wrong slots) → invalid_backend_response', async () => {
  const savedFetch = globalThis.fetch;
  const cases: unknown[] = [
    { unexpected: 'object' },
    ['grace hopper', ['Only Titles']],
    ['grace hopper', ['Titles'], 'descriptions not array', ['https://en.wikipedia.org/wiki/A']],
  ];
  try {
    for (const body of cases) {
      globalThis.fetch = async () => jsonResponse(body);
      const result = await searchWikipedia({ query: 'q', env: {} });
      assert.equal(result.status, 'error');
      assert.equal(result.errors[0]?.code, 'invalid_backend_response');
      assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikipedia: rows with missing/empty urls → invalid_entity, never silent empty success', async () => {
  const savedFetch = globalThis.fetch;
  // Two valid rows, one row whose url slot is empty → partial, one invalid_entity error.
  globalThis.fetch = async () => jsonResponse([
    'q',
    ['Good One', 'Bad Row', 'Good Two'],
    ['d1', 'd2', 'd3'],
    ['https://en.wikipedia.org/wiki/Good_One', '', 'https://en.wikipedia.org/wiki/Good_Two'],
  ]);
  try {
    const result = await searchWikipedia({ query: 'q', env: {} });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'partial');
    assert.equal(result.errors.filter((e) => e.code === 'invalid_entity').length, 1);
    if (result.data.kind !== 'entities') return;
    assert.equal(result.data.entities.length, 2);
    assert.deepEqual(result.data.entities.map((e) => e.title), ['Good One', 'Good Two']);
  } finally {
    globalThis.fetch = savedFetch;
  }

  // All rows malformed → error status (not empty success).
  globalThis.fetch = async () => jsonResponse(['q', ['A', 'B'], [], ['', '']]);
  try {
    const result = await searchWikipedia({ query: 'q', env: {} });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_entity');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikipedia: cursor → pagination_not_supported, no fetch', async () => {
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(['q', [], [], []]);
  };
  try {
    const result = await searchWikipedia({ query: 'q', cursor: 'not-a-real-cursor', env: {} });
    assert.equal(calls, 0);
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.errors[0]?.code, 'pagination_not_supported');
    assert.equal(result.pagination.supported, false);
    assert.equal(result.pagination.hasMore, false);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikipedia: unsupported filters rejected, no fetch', async () => {
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(['q', [], [], []]);
  };
  try {
    for (const extra of [{ yearFrom: 2020 }, { author: 'Hopper' }, { doi: '10.1/x' }, { venue: 'CACM' }]) {
      const result = await searchWikipedia({ query: 'q', ...extra, env: {} });
      assert.equal(calls, 0);
      assert.equal(result.status, 'error');
      assert.equal(result.errors[0]?.code, 'invalid_input');
      assert.equal(result.pagination.supported, false);
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
});