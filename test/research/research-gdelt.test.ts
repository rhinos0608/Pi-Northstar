import assert from 'node:assert/strict';
import { test } from 'node:test';
import { researchSourceCapability } from '../../src/capabilities.js';
import {
  GDELT_BACKEND,
  GDELT_ENDPOINT,
  GDELT_SOURCE,
  searchGdelt,
} from '../../src/research/research-gdelt.js';
import { validateNorthstarResult } from '../../src/result-contract.js';

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

function statusResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

function article(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://www.example.com/news/story',
    title: 'Example story about climate',
    seendate: '20240229T063000Z',
    domain: 'example.com',
    language: 'English',
    sourcecountry: 'United States',
    ...overrides,
  };
}

test('searchGdelt builds the official artlist JSON URL with maxrecords', async () => {
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ articles: [] });
  }, () => searchGdelt({ query: '"climate policy" OR energy', limit: 5 }));
  assert.equal(result.status, 'empty');
  const url = new URL(captured);
  assert.equal(url.origin + url.pathname, GDELT_ENDPOINT);
  assert.equal(url.searchParams.get('query'), '"climate policy" OR energy');
  assert.equal(url.searchParams.get('mode'), 'artlist');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('maxrecords'), '5');
});

test('searchGdelt bounds STARTDATETIME from yearFrom', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ articles: [] });
  }, () => searchGdelt({ query: 'climate', yearFrom: 2023 }));
  assert.equal(new URL(captured).searchParams.get('startdatetime'), '20230101000000');
});

test('searchGdelt clamps bounded limits into maxrecords', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ articles: [] });
  }, () => searchGdelt({ query: 'q', limit: 500 }));
  assert.equal(new URL(captured).searchParams.get('maxrecords'), '30');

  let defaultCaptured = '';
  await withFetch(async (input) => {
    defaultCaptured = String(input);
    return jsonResponse({ articles: [] });
  }, () => searchGdelt({ query: 'q' }));
  assert.equal(new URL(defaultCaptured).searchParams.get('maxrecords'), '10');
});

test('searchGdelt rejects cursors with pagination_not_supported without fetching', async () => {
  let fetched = false;
  const result = await withFetch(async () => {
    fetched = true;
    return jsonResponse({ articles: [] });
  }, () => searchGdelt({ query: 'q', cursor: 'eyJ2IjoxfQ' }));
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0]?.code, 'pagination_not_supported');
  assert.equal(result.pagination.supported, false);
  assert.equal(result.pagination.hasMore, false);
  assert.equal(fetched, false);
});

test('searchGdelt maps articles to article entities', async () => {
  const result = await withFetch(
    async () => jsonResponse({ articles: [article()] }),
    () => searchGdelt({ query: 'climate' }),
  );
  assert.equal(result.status, 'ok');
  assert.ok(validateNorthstarResult(result).ok, JSON.stringify(validateNorthstarResult(result).issues));
  if (result.data.kind !== 'entities') return;
  const entity = result.data.entities[0]!;
  assert.equal(entity.kind, 'article');
  assert.equal(entity.source, GDELT_SOURCE);
  assert.equal(entity.id, 'https://www.example.com/news/story');
  assert.equal(entity.url, 'https://www.example.com/news/story');
  assert.equal(entity.title, 'Example story about climate');
  assert.equal(entity.venue, 'example.com');
  assert.equal(entity.publishedAt, '2024-02-29T06:30:00.000Z');
  assert.equal(entity.year, 2024);
  assert.equal(result.sources[0]?.backend, GDELT_BACKEND);
  assert.equal(result.request.source, GDELT_SOURCE);
});

test('searchGdelt backend matches the capability registry', () => {
  const capability = researchSourceCapability('gdelt');
  assert.ok(capability);
  assert.equal(capability.backend, GDELT_BACKEND);
  assert.equal(capability.entityKind, 'article');
  assert.equal(capability.pagination, 'unsupported');
});

test('searchGdelt classifies non-JSON HTTP 200 bodies through the shared HTTP helper', async () => {
  const result = await withFetch(
    async () => new Response('<html>query too broad</html>', { status: 200 }),
    () => searchGdelt({ query: 'q' }),
  );
  // Shared helper classifies JSON parse failures as backend_unavailable;
  // schema-less JSON (missing articles array) remains invalid_backend_response.
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0]?.code, 'backend_unavailable');
});

test('searchGdelt rejects HTTP 200 payloads missing the articles array', async () => {
  for (const payload of [{ notice: 'query too broad' }, [], null]) {
    const result = await withFetch(async () => jsonResponse(payload), () => searchGdelt({ query: 'q' }));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
  }
});

test('searchGdelt drops malformed rows and reports invalid_entity with partial status', async () => {
  const result = await withFetch(
    async () => jsonResponse({ articles: [article(), article({ url: '' }), { title: 'no url' }, null] }),
    () => searchGdelt({ query: 'q' }),
  );
  assert.equal(result.status, 'partial');
  assert.ok(result.errors.some((error) => error.code === 'invalid_entity'));
  if (result.data.kind === 'entities') assert.equal(result.data.entities.length, 1);
});

test('searchGdelt omits publishedAt and year for malformed seendate values', async () => {
  const result = await withFetch(
    async () => jsonResponse({ articles: [article({ seendate: 'not-a-date' })] }),
    () => searchGdelt({ query: 'q' }),
  );
  assert.equal(result.status, 'ok');
  if (result.data.kind !== 'entities') return;
  assert.equal(result.data.entities[0]?.publishedAt, undefined);
  assert.equal(result.data.entities[0]?.year, undefined);
});

test('searchGdelt rejects the unsupported author, doi, and venue filters', async () => {
  for (const field of ['author', 'doi', 'venue'] as const) {
    const result = await withFetch(
      async () => { throw new Error('should not fetch'); },
      () => searchGdelt({ query: 'q', [field]: 'x' }),
    );
    assert.equal(result.errors[0]?.code, 'invalid_input');
    assert.match(result.errors[0]?.message ?? '', new RegExp(`does not support the "${field}" filter`));
    // GDELT has no pagination, so even filter rejections never advertise it.
    assert.equal(result.pagination.supported, false);
  }
});

test('searchGdelt maps HTTP failures to sanitized error envelopes', async () => {
  const limited = await withFetch(async () => statusResponse(429), () => searchGdelt({ query: 'q' }));
  assert.equal(limited.errors[0]?.code, 'rate_limited');
  assert.doesNotMatch(JSON.stringify(limited.errors), /https?:\/\//);

  const server = await withFetch(async () => statusResponse(502), () => searchGdelt({ query: 'q' }));
  assert.equal(server.errors[0]?.code, 'backend_http_error');
  assert.equal(server.errors[0]?.retryable, true);
});

test('searchGdelt rejects non-integer limits and empty queries as invalid_input', async () => {
  const result = await withFetch(
    async () => { throw new Error('should not fetch'); },
    () => searchGdelt({ query: '   ', limit: 2.5 }),
  );
  assert.equal(result.errors[0]?.code, 'invalid_input');
});

test('searchGdelt propagates caller aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchGdelt({ query: 'q', signal: controller.signal }),
    (error: Error) => error.name === 'AbortError',
  );
});

test('searchGdelt registry marks the STARTDATETIME year filter as supported', () => {
  const capability = researchSourceCapability('gdelt');
  assert.ok(capability);
  assert.equal(capability.yearFilter, 'supported');
});
