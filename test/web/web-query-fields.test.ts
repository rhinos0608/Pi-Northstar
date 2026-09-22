import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWebRequest } from '../../src/web/web-contract.js';
import { applyWebQueryFieldFilters, webSearch } from '../../src/web/web.js';

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

async function rejectsInvalid(fn: () => Promise<unknown> | unknown, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal(codeOf(err), 'invalid_request');
    assert.match(err instanceof Error ? err.message : String(err), pattern);
    return;
  }
  assert.fail('expected invalid_request rejection');
}

test('search validates XOR query|queries and new query fields', async () => {
  assert.deepEqual(validateWebRequest({ action: 'search', queries: ['a', 'b'] }).request.queries, ['a', 'b']);
  const full = validateWebRequest({
    action: 'search',
    query: 'q',
    includeContent: true,
    recency: 'week',
    domains: ['example.com', '-blocked.com'],
    yearFrom: 2020,
  }).request;
  assert.equal(full.includeContent, true);
  assert.equal(full.recency, 'week');
  assert.deepEqual(full.domains, ['example.com', '-blocked.com']);
  assert.equal(full.yearFrom, 2020);
  await rejectsInvalid(() => validateWebRequest({ action: 'search', query: 'a', queries: ['b'] }), /exactly one of query or queries/);
  await rejectsInvalid(() => validateWebRequest({ action: 'search', queries: [] }), /1-8/);
  await rejectsInvalid(() => validateWebRequest({ action: 'search', query: 'a', recency: 'hour' }), /recency must be one of/);
  await rejectsInvalid(() => validateWebRequest({ action: 'search', query: 'a', domains: ['not a host!!'] }), /invalid domains hostname/);
  await rejectsInvalid(() => validateWebRequest({ action: 'search', query: 'a', yearFrom: 1800 }), /yearFrom must be an integer/);
  await rejectsInvalid(() => validateWebRequest({ action: 'search', query: 'a', includeContent: 'yes' }), /includeContent must be a boolean/);
  await rejectsInvalid(
    () => validateWebRequest({ action: 'search', queries: ['a', 'b'], cursor: 'x' }),
    /only supported with a single query/,
  );
  await rejectsInvalid(() => validateWebRequest({ action: 'crawl', query: 'a', url: 'https://x.test/', queries: ['a'] }), /only supported on web search/);
  await rejectsInvalid(() => validateWebRequest({ action: 'read', url: 'https://x.test/', recency: 'day' }), /only supported on web search/);
});

test('post-filter drops stale/excluded hits and retains undated ones', () => {
  const hits = [
    { title: 'fresh', url: 'https://example.com/a', snippet: 's', backend: 'tinyfish' as const, publishedDate: new Date().toISOString() },
    { title: 'old', url: 'https://example.com/old', snippet: 's', backend: 'tinyfish' as const, publishedDate: '2020-01-01T00:00:00.000Z' },
    { title: 'undated', url: 'https://example.com/u', snippet: 's', backend: 'tinyfish' as const },
    { title: 'blocked', url: 'https://blocked.com/x', snippet: 's', backend: 'tinyfish' as const },
    { title: 'unparsable', url: '::not a url', snippet: 's', backend: 'tinyfish' as const },
  ];
  const out = applyWebQueryFieldFilters(hits, { recency: 'week', domains: ['example.com', '-blocked.com'] });
  assert.deepEqual(out.map((h) => h.title).sort(), ['fresh', 'undated']);
  assert.deepEqual(applyWebQueryFieldFilters(hits, {}).length, 5);
});

test('webSearch passes recency/domains through provider inputs and post-filters', async () => {
  const seen: string[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const body = {
      results: [
        { title: 'fresh', url: 'https://example.com/fresh', snippet: 'new', date: new Date().toISOString() },
        { title: 'stale', url: 'https://example.com/stale', snippet: 'old', date: '2019-05-01T00:00:00Z' },
        { title: 'nodate', url: 'https://example.com/nodate', snippet: 'kept' },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const env = { TINYFISH_API_KEY: 'key', PI_SEARCH_WEB_BACKENDS: 'tinyfish' };
    const result = await webSearch(
      { query: 'q', recency: 'week', domains: ['example.com'], yearFrom: 2020 },
      { env },
    );
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /recency_minutes=10080/);
    assert.match(seen[0]!, /include_domains=example\.com/);
    const details = result.details as { results: Array<{ title: string; url: string }> };
    assert.deepEqual(details.results.map((r) => r.title).sort(), ['fresh', 'nodate']);
  } finally {
    globalThis.fetch = saved;
  }
});

test('webSearch fans out queries arrays and fuses per-query rankings', async () => {
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls++;
    const url = new URL(String(input));
    const q = url.searchParams.get('query') ?? `q${calls}`;
    const body = { results: [{ title: `hit-${q}`, url: `https://example.com/${q}`, snippet: q }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const env = { TINYFISH_API_KEY: 'key', PI_SEARCH_WEB_BACKENDS: 'tinyfish' };
    const result = await webSearch({ queries: ['alpha', 'beta'], limit: 5 }, { env });
    assert.equal(calls, 2);
    const details = result.details as {
      results: Array<{ url: string }>;
      attemptedProviders?: string[];
      totalProviderSearches?: number;
      perQueryFanout?: Array<{ query: string; attemptedProviders: string[]; providerSearches: number; hitsCount: number }>;
      fusion?: {
        attemptedProviders?: string[];
        totalProviderSearches?: number;
        perQueryFanout?: Array<{ query: string; attemptedProviders: string[]; providerSearches: number; hitsCount: number }>;
      };
    };
    assert.deepEqual(details.results.map((r) => r.url).sort(), ['https://example.com/alpha', 'https://example.com/beta']);
    assert.deepEqual(details.attemptedProviders, ['tinyfish']);
    assert.equal(details.totalProviderSearches, 2);
    assert.equal(details.perQueryFanout?.length, 2);
    assert.equal(details.perQueryFanout?.[0]?.query, 'alpha');
    assert.deepEqual(details.perQueryFanout?.[0]?.attemptedProviders, ['tinyfish']);
    assert.equal(details.perQueryFanout?.[0]?.providerSearches, 1);
    assert.equal(details.perQueryFanout?.[0]?.hitsCount, 1);
    assert.equal(details.fusion?.totalProviderSearches, 2);
    assert.deepEqual(details.fusion?.attemptedProviders, ['tinyfish']);
  } finally {
    globalThis.fetch = saved;
  }
});
