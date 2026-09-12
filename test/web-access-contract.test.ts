import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WEB_ACCESS_BATCH_CONCURRENCY,
  WEB_ACCESS_ERROR_KINDS,
  WEB_ACCESS_MAX_BATCH_QUERIES,
  WEB_ACCESS_PROVIDER_IDS,
  WEB_ACCESS_RETRIEVAL_MAX_CHARS,
  WEB_ACCESS_STORE_MAX_BYTES,
  WEB_ACCESS_STORE_MAX_ENTRIES,
  WEB_ACCESS_STORE_TTL_MS,
  isRetryableWebAccessError,
  isWebAccessErrorKind,
  isWebAccessProviderId,
  normalizeWebAccessSearchRequest,
  normalizeWebAccessContentSlice,
  parseWebAccessFetchRequest,
  passesWebAccessFreshness,
  resolveWebAccessRecencyLowerBound,
  validateWebAccessProviderResponse,
  webAccessErrorKindForStatus,
  WebAccessContractError,
} from '../src/web-access-contract.js';

test('provider inventory stays 30 ids as output-provenance vocabulary', () => {
  assert.equal(WEB_ACCESS_PROVIDER_IDS.length, 30);
  assert.equal(isWebAccessProviderId('tavily'), true);
  assert.equal(isWebAccessProviderId('codex'), false);
  assert.equal(isWebAccessProviderId('openai'), false);
});

test('search requires XOR query/queries and rejects both or neither', () => {
  assert.deepEqual(normalizeWebAccessSearchRequest({ query: 'q' }).queries, ['q']);
  assert.deepEqual(normalizeWebAccessSearchRequest({ queries: ['a', 'b'] }).queries, ['a', 'b']);
  assert.throws(
    () => normalizeWebAccessSearchRequest({ query: 'a', queries: ['a'] }),
    WebAccessContractError,
  );
  assert.throws(() => normalizeWebAccessSearchRequest({}), WebAccessContractError);
  assert.throws(() => normalizeWebAccessSearchRequest({ queries: [] }), WebAccessContractError);
  assert.throws(
    () => normalizeWebAccessSearchRequest({ queries: Array.from({ length: 9 }, (_, i) => `q${i}`) }),
    WebAccessContractError,
  );
});

test('search rejects provider and legacy selector fields', () => {
  for (const raw of [
    { query: 'q', provider: 'tavily' },
    { query: 'q', recencyFilter: 'day' },
    { query: 'q', domainFilter: ['example.com'] },
    { query: 'q', numResults: 5 },
    { query: 'q', workflow: 'auto' },
    { query: 'q', fallbackOn: ['timeout'] },
  ]) {
    assert.throws(() => normalizeWebAccessSearchRequest(raw), WebAccessContractError);
  }
});

test('search cursor only with single query; defaults includeContent false', () => {
  const single = normalizeWebAccessSearchRequest({ query: 'q', cursor: 'c1' });
  assert.equal(single.cursor, 'c1');
  assert.equal(single.includeContent, false);
  assert.throws(
    () => normalizeWebAccessSearchRequest({ queries: ['a', 'b'], cursor: 'c1' }),
    WebAccessContractError,
  );
  const withContent = normalizeWebAccessSearchRequest({ query: 'q', includeContent: true });
  assert.equal(withContent.includeContent, true);
});

test('search accepts FINAL optional fields and validates ranges', () => {
  const req = normalizeWebAccessSearchRequest({
    query: 'q',
    limit: 8,
    recency: 'week',
    domains: ['Example.COM'],
    category: 'news',
    source: 'web',
    yearFrom: 2020,
    knowledge: true,
    mode: 'fast',
  });
  assert.equal(req.limit, 8);
  assert.equal(req.recency, 'week');
  assert.deepEqual(req.domains, ['example.com']);
  assert.equal(req.yearFrom, 2020);
  assert.throws(() => normalizeWebAccessSearchRequest({ query: 'q', recency: 'hour' }), WebAccessContractError);
  assert.throws(() => normalizeWebAccessSearchRequest({ query: 'q', yearFrom: 1800 }), WebAccessContractError);
  assert.throws(() => normalizeWebAccessSearchRequest({ query: 'q', domains: ['bad host!'] }), WebAccessContractError);
});

test('recency/yearFrom intersect uses later bound; undated passes', () => {
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  const day = resolveWebAccessRecencyLowerBound({ recency: 'day', now });
  assert.equal(day, now - 24 * 60 * 60 * 1000);
  const yearBound = Date.UTC(2024, 0, 1);
  const both = resolveWebAccessRecencyLowerBound({ recency: 'year', yearFrom: 2024, now });
  assert.ok(both !== undefined && both >= yearBound);
  assert.equal(resolveWebAccessRecencyLowerBound({}), undefined);
  assert.equal(passesWebAccessFreshness(undefined, day), true);
  assert.equal(passesWebAccessFreshness('not-a-date', day), true);
  assert.equal(passesWebAccessFreshness(new Date((day ?? 0) + 1000).toISOString(), day), true);
  assert.equal(passesWebAccessFreshness(new Date((day ?? 0) - 1000).toISOString(), day), false);
});

test('fetch normal requires XOR url/urls/searchQuery+query; no format', () => {
  assert.throws(() => parseWebAccessFetchRequest({ url: 'https://a.example/', format: 'markdown' }), /format/);
  const single = parseWebAccessFetchRequest({ url: 'https://a.example/' });
  assert.ok('url' in single && single.url === 'https://a.example/');
  const multi = parseWebAccessFetchRequest({ urls: ['https://a.example/', 'https://b.example/'] });
  assert.ok('urls' in multi && (multi.urls ?? []).length === 2);
  assert.throws(() => parseWebAccessFetchRequest({}), WebAccessContractError);
  assert.throws(
    () => parseWebAccessFetchRequest({ url: 'https://a.example/', urls: ['https://b.example/'] }),
    WebAccessContractError,
  );
  assert.throws(() => parseWebAccessFetchRequest({ searchQuery: 'q' }), /query/);
  const sq = parseWebAccessFetchRequest({ searchQuery: 'q', query: 'passage' });
  assert.ok('query' in sq && sq.query === 'passage');
  assert.throws(
    () => parseWebAccessFetchRequest({ urls: ['https://a.example/'], query: 'p', followLinks: true }),
    /followLinks/,
  );
  const fl = parseWebAccessFetchRequest({ url: 'https://a.example/', query: 'p', followLinks: true });
  assert.ok('followLinks' in fl && fl.followLinks === true);
  assert.throws(() => parseWebAccessFetchRequest({ url: 'https://a.example/', sitemap: true, query: 'p' }), /sitemap/);
});

test('fetch retrieve/source_check enforce responseId and claim bounds', () => {
  assert.throws(() => parseWebAccessFetchRequest({ action: 'retrieve' }), /responseId/);
  const ret = parseWebAccessFetchRequest({ action: 'retrieve', responseId: 'r1', findText: 'hi', offset: 5 });
  assert.ok('action' in ret && ret.action === 'retrieve');
  assert.throws(() => parseWebAccessFetchRequest({ action: 'source_check', responseId: 'r1', claims: [] }), /claims/);
  assert.throws(
    () =>
      parseWebAccessFetchRequest({
        action: 'source_check',
        responseId: 'r1',
        claims: Array.from({ length: 21 }, (_, i) => `c${i}`),
      }),
    /claims/,
  );
  const sc = parseWebAccessFetchRequest({ action: 'source_check', responseId: 'r1', claims: ['c1'] });
  assert.ok('action' in sc && sc.action === 'source_check');
});

test('error taxonomy, retryability, and status mapping hold', () => {
  assert.equal(WEB_ACCESS_ERROR_KINDS.length, 11);
  assert.equal(isWebAccessErrorKind('quota'), true);
  assert.equal(isWebAccessErrorKind('nope'), false);
  assert.equal(isRetryableWebAccessError('quota'), true);
  assert.equal(isRetryableWebAccessError('auth'), false);
  assert.equal(webAccessErrorKindForStatus(432), 'quota');
  assert.equal(webAccessErrorKindForStatus(429), 'rate_limited');
  assert.equal(webAccessErrorKindForStatus(401), 'auth');
});

test('provider response validation bounds results and text', () => {
  const ok = validateWebAccessProviderResponse({
    provider: 'tavily',
    results: [{ title: 'T', url: 'https://example.com/', snippet: 's' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(validateWebAccessProviderResponse({ provider: 'nope', results: [] }).ok, false);
  assert.equal(
    validateWebAccessProviderResponse({
      provider: 'tavily',
      results: Array.from({ length: 21 }, (_, i) => ({ title: 't', url: `https://e.com/${i}`, snippet: 's' })),
    }).ok,
    false,
  );
});

test('content slice keeps findText-wins semantics', () => {
  assert.deepEqual(normalizeWebAccessContentSlice({ offset: 2, limit: 9 }), { offset: 2, limit: 9 });
  assert.deepEqual(normalizeWebAccessContentSlice({ findText: 'hi', offset: 99, limit: 1 }), { findText: 'hi' });
  assert.throws(() => normalizeWebAccessContentSlice({ offset: -1 }), /offset/);
  assert.throws(() => normalizeWebAccessContentSlice({ limit: WEB_ACCESS_RETRIEVAL_MAX_CHARS + 1 }), /limit/);
});

test('store bounds match FINAL memory cache', () => {
  assert.equal(WEB_ACCESS_BATCH_CONCURRENCY, 3);
  assert.equal(WEB_ACCESS_MAX_BATCH_QUERIES, 8);
  assert.equal(WEB_ACCESS_STORE_MAX_ENTRIES, 128);
  assert.equal(WEB_ACCESS_STORE_MAX_BYTES, 128 * 1024 * 1024);
  assert.equal(WEB_ACCESS_STORE_TTL_MS, 3_600_000);
});
