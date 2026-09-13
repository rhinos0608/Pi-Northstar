import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchWikidata } from '../../src/research/research-wikidata.js';
import { decodeResultCursor, encodeResultCursor, validateNorthstarResult } from '../../src/result-contract.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('wikidata: valid wbsearchentities response maps rows and continuation cursor', async () => {
  const urls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    return jsonResponse({
      searchinfo: { search: 'ada lovelace' },
      searchcontinue: 10,
      search: [
        {
          id: 'Q7259',
          label: 'Ada Lovelace',
          concepturi: 'https://www.wikidata.org/wiki/Q7259',
          description: 'English mathematician',
        },
        { id: 'Q42', label: 'Douglas Adams' },
      ],
    });
  };
  try {
    const result = await searchWikidata({ query: 'ada lovelace', limit: 2, env: {} });
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]!);
    assert.equal(url.origin + url.pathname, 'https://www.wikidata.org/w/api.php');
    assert.equal(url.searchParams.get('action'), 'wbsearchentities');
    assert.equal(url.searchParams.get('search'), 'ada lovelace');
    assert.equal(url.searchParams.get('continue'), '0');

    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'ok');
    assert.equal(result.sources[0]?.backend, 'wikidata-api');
    if (result.data.kind !== 'entities') return;
    assert.equal(result.data.entities.length, 2);
    const first = result.data.entities[0]!;
    assert.equal(first.kind, 'article');
    assert.equal(first.source, 'wikidata');
    assert.equal(first.id, 'Q7259');
    assert.equal(first.url, 'https://www.wikidata.org/wiki/Q7259');
    assert.equal(first.snippet, 'English mathematician');
    // Row without concepturi falls back to the canonical entity URL.
    assert.equal(result.data.entities[1]?.url, 'https://www.wikidata.org/wiki/Q42');

    assert.equal(result.pagination.hasMore, true);
    const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'wikidata', query: 'ada lovelace' });
    assert.equal(decoded.state.continue, 10);

    // Continuation: next call passes the offset through to the API.
    await searchWikidata({ query: 'ada lovelace', limit: 2, cursor: result.pagination.nextCursor!, env: {} });
    assert.equal(new URL(urls[1]!).searchParams.get('continue'), '10');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikidata: malformed container (non-record / missing search array) → invalid_backend_response', async () => {
  const savedFetch = globalThis.fetch;
  const cases: unknown[] = ['not json object', 42, { search: 'not an array' }, { searchcontinue: 5 }];
  try {
    for (const body of cases) {
      globalThis.fetch = async () => jsonResponse(body);
      const result = await searchWikidata({ query: 'q', env: {} });
      assert.equal(result.status, 'error');
      assert.equal(result.errors[0]?.code, 'invalid_backend_response');
      assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikidata: malformed rows counted as invalid_entity, never silent empty success', async () => {
  const savedFetch = globalThis.fetch;
  // Mixed page: one valid row, one object missing id/url, one non-object row.
  globalThis.fetch = async () => jsonResponse({
    searchcontinue: 7,
    search: [
      { id: 'Q1', label: 'Valid', concepturi: 'https://www.wikidata.org/wiki/Q1' },
      { label: 'No id, no concepturi' },
      'garbage row',
    ],
  });
  try {
    const result = await searchWikidata({ query: 'q', env: {} });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'partial');
    assert.equal(result.errors.filter((e) => e.code === 'invalid_entity').length, 1);
    if (result.data.kind !== 'entities') return;
    assert.equal(result.data.entities.length, 1);
    assert.equal(result.data.entities[0]?.id, 'Q1');
  } finally {
    globalThis.fetch = savedFetch;
  }

  // All-malformed page → error status with invalid_entity, not 'empty' success.
  globalThis.fetch = async () => jsonResponse({ search: [{ label: 'A' }, null] });
  try {
    const result = await searchWikidata({ query: 'q', env: {} });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_entity');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikidata: zero-result page with searchcontinue does not mint hasMore/nextCursor', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ searchcontinue: 10, search: [] });
  try {
    const result = await searchWikidata({ query: 'no such entity xyz', env: {} });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'empty');
    assert.equal(result.errors.length, 0);
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.nextCursor, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikidata: stale searchcontinue on last page → no cursor', async () => {
  const savedFetch = globalThis.fetch;
  // searchcontinue not greater than the current offset → exhausted.
  globalThis.fetch = async () => jsonResponse({
    searchcontinue: 0,
    search: [{ id: 'Q1', label: 'Only Page', concepturi: 'https://www.wikidata.org/wiki/Q1' }],
  });
  try {
    const result = await searchWikidata({ query: 'q', env: {} });
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'ok');
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.nextCursor, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikidata: foreign-source cursor → pagination_not_supported, no fetch', async () => {
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ search: [] });
  };
  try {
    const foreign = encodeResultCursor({ source: 'openalex', query: 'q', state: { cursor: 'abc' } });
    const result = await searchWikidata({ query: 'q', cursor: foreign, env: {} });
    assert.equal(calls, 0);
    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.errors[0]?.code, 'pagination_not_supported');
    assert.equal(result.pagination.supported, false);
    assert.equal(result.pagination.hasMore, false);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('wikidata: unsupported filters rejected, no fetch', async () => {
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ search: [] });
  };
  try {
    for (const extra of [{ yearFrom: 2020 }, { author: 'Lovelace' }, { doi: '10.1/x' }, { venue: 'CACM' }]) {
      const result = await searchWikidata({ query: 'q', ...extra, env: {} });
      assert.equal(calls, 0);
      assert.equal(result.status, 'error');
      assert.equal(result.errors[0]?.code, 'invalid_input');
      assert.ok(/does not support/.test(result.errors[0]?.message ?? ''));
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
});