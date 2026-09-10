import assert from 'node:assert/strict';
import { test } from 'node:test';
import { researchSourceCapability } from '../src/capabilities.js';
import {
  ROR_BACKEND,
  ROR_ENDPOINT,
  ROR_MAX_PAGE,
  ROR_PAGE_SIZE,
  searchRor,
} from '../src/research-ror.js';
import {
  decodeResultCursor,
  encodeResultCursor,
  validateNorthstarResult,
} from '../src/result-contract.js';

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

function orgItem(index: number): Record<string, unknown> {
  return {
    id: `https://ror.org/org${index}`,
    names: [
      { value: `Organization ${index}`, types: ['ror_display', 'label'] },
      { value: `Org${index}`, types: ['acronym'] },
    ],
    links: [`https://www.org${index}.example`],
    established: 1900 + index,
    locations: [{ geonames_details: { country_name: 'Norway' } }],
  };
}

function orgPage(count: number, offset = 0): Record<string, unknown> {
  return {
    number_of_results: offset + count,
    items: Array.from({ length: count }, (_, index) => orgItem(offset + index)),
  };
}

test('searchRor builds the official organizations URL', async () => {
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ number_of_results: 0, items: [] });
  }, () => searchRor({ query: 'university of oslo', limit: 5 }));
  assert.equal(result.status, 'empty');
  const url = new URL(captured);
  assert.equal(url.origin + url.pathname, ROR_ENDPOINT);
  assert.equal(url.searchParams.get('query'), 'university of oslo');
  assert.equal(url.searchParams.get('page'), '1');
});

test('searchRor rejects yearFrom explicitly without fetching', async () => {
  let fetched = false;
  const result = await withFetch(async () => {
    fetched = true;
    return jsonResponse({ number_of_results: 0, items: [] });
  }, () => searchRor({ query: 'q', yearFrom: 2020 }));
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0]?.code, 'invalid_input');
  assert.match(result.errors[0]?.message ?? '', /does not support date filtering/);
  assert.equal(fetched, false);
});

test('searchRor rejects the unsupported author, doi, and venue filters', async () => {
  for (const field of ['author', 'doi', 'venue'] as const) {
    const result = await withFetch(
      async () => { throw new Error('should not fetch'); },
      () => searchRor({ query: 'q', [field]: 'x' }),
    );
    assert.equal(result.errors[0]?.code, 'invalid_input');
    assert.match(result.errors[0]?.message ?? '', new RegExp(`does not support the "${field}" filter`));
    // ROR pages results, so rejected filters keep pagination advertised.
    assert.equal(result.pagination.supported, true);
    assert.equal(result.pagination.hasMore, false);
  }
});

test('searchRor maps organization rows with ror_display name precedence', async () => {
  const result = await withFetch(
    async () => jsonResponse({ number_of_results: 1, items: [orgItem(1)] }),
    () => searchRor({ query: 'oslo' }),
  );
  assert.equal(result.status, 'ok');
  assert.ok(validateNorthstarResult(result).ok, JSON.stringify(validateNorthstarResult(result).issues));
  if (result.data.kind !== 'entities') return;
  const entity = result.data.entities[0]!;
  assert.equal(entity.kind, 'organization');
  assert.equal(entity.source, 'ror');
  assert.equal(entity.id, 'https://ror.org/org1');
  assert.equal(entity.url, 'https://www.org1.example');
  assert.equal(entity.title, 'Organization 1');
  assert.equal(entity.year, 1901);
  assert.equal(entity.snippet, 'Norway');
  assert.equal(result.sources[0]?.backend, ROR_BACKEND);
});

test('searchRor falls back to the ROR id as url and label as title', async () => {
  const row = {
    id: 'https://ror.org/org9',
    names: [{ value: 'Fallback University', types: ['label'] }],
    links: [],
  };
  const result = await withFetch(
    async () => jsonResponse({ number_of_results: 1, items: [row] }),
    () => searchRor({ query: 'q' }),
  );
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.equal(result.data.entities[0]?.url, 'https://ror.org/org9');
  assert.equal(result.data.entities[0]?.title, 'Fallback University');
});

test('searchRor backend matches the capability registry', () => {
  const capability = researchSourceCapability('ror');
  assert.ok(capability);
  assert.equal(capability.backend, ROR_BACKEND);
  assert.equal(capability.entityKind, 'organization');
  assert.equal(capability.pagination, 'page-offset');
  assert.equal(capability.yearFilter, 'unsupported');
});

test('searchRor slices fixed 20-item pages and emits an offset cursor', async () => {
  const result = await withFetch(
    async () => jsonResponse(orgPage(20)),
    () => searchRor({ query: 'q', limit: 5 }),
  );
  assert.equal(result.pagination.returned, 5);
  assert.equal(result.pagination.hasMore, true);
  assert.ok(result.pagination.nextCursor);
  const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'ror', query: 'q' });
  assert.deepEqual(decoded.state, { page: 1, offset: 5 });
});

test('searchRor resumes from an offset cursor with a repeated page fetch', async () => {
  const cursor = encodeResultCursor({ source: 'ror', query: 'q', state: { page: 1, offset: 5 } });
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse(orgPage(20));
  }, () => searchRor({ query: 'q', limit: 5, cursor }));
  assert.equal(new URL(captured).searchParams.get('page'), '1');
  if (result.data.kind !== 'entities') return assert.fail('expected entities');
  assert.deepEqual(
    result.data.entities.map((entity) => entity.id),
    ['https://ror.org/org5', 'https://ror.org/org6', 'https://ror.org/org7', 'https://ror.org/org8', 'https://ror.org/org9'],
  );
  const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'ror', query: 'q' });
  assert.deepEqual(decoded.state, { page: 1, offset: 10 });
});

test('searchRor advances to the next page once the current page is consumed', async () => {
  const cursor = encodeResultCursor({ source: 'ror', query: 'q', state: { page: 1, offset: 10 } });
  let captured = '';
  const result = await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ number_of_results: 25, items: Array.from({ length: 20 }, (_, index) => orgItem(index)) });
  }, () => searchRor({ query: 'q', limit: 10, cursor }));
  assert.equal(new URL(captured).searchParams.get('page'), '1');
  assert.equal(result.pagination.returned, 10);
  const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'ror', query: 'q' });
  assert.deepEqual(decoded.state, { page: 2, offset: 0 });

  let captured2 = '';
  const second = await withFetch(async (input) => {
    captured2 = String(input);
    return jsonResponse({ number_of_results: 30, items: Array.from({ length: 20 }, (_, index) => orgItem(index + 20)) });
  }, () => searchRor({ query: 'q', limit: 5, cursor: result.pagination.nextCursor! }));
  assert.equal(new URL(captured2).searchParams.get('page'), '2');
  assert.equal(second.pagination.returned, 5);
  assert.equal(second.pagination.hasMore, true);
});

test('searchRor stops at the end of the result set', async () => {
  const result = await withFetch(
    async () => jsonResponse({ number_of_results: 3, items: [orgItem(1), orgItem(2), orgItem(3)] }),
    () => searchRor({ query: 'q' }),
  );
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
  assert.equal(result.status, 'ok');
});

test('searchRor accepts metadata.number_of_results as the total', async () => {
  const result = await withFetch(
    async () => jsonResponse({ metadata: { number_of_results: 1 }, items: [orgItem(1)] }),
    () => searchRor({ query: 'q' }),
  );
  assert.equal(result.status, 'ok');
});

test('searchRor rejects HTTP 200 payloads missing items or total', async () => {
  for (const payload of [{}, { items: [] }, { number_of_results: 5 }, [1, 2]]) {
    const result = await withFetch(async () => jsonResponse(payload), () => searchRor({ query: 'q' }));
    assert.equal(result.status, 'error');
    assert.equal(result.errors[0]?.code, 'invalid_backend_response');
  }
});

test('searchRor drops malformed rows and reports invalid_entity with partial status', async () => {
  const result = await withFetch(
    async () => jsonResponse({ number_of_results: 3, items: [orgItem(1), { names: [] }, null] }),
    () => searchRor({ query: 'q' }),
  );
  assert.equal(result.status, 'partial');
  assert.ok(result.errors.some((error) => error.code === 'invalid_entity'));
  if (result.data.kind === 'entities') assert.equal(result.data.entities.length, 1);
});

test('searchRor maps HTTP failures to sanitized error envelopes', async () => {
  const limited = await withFetch(async () => statusResponse(429), () => searchRor({ query: 'q' }));
  assert.equal(limited.errors[0]?.code, 'rate_limited');
  assert.doesNotMatch(JSON.stringify(limited.errors), /https?:\/\//);

  const server = await withFetch(async () => statusResponse(503), () => searchRor({ query: 'q' }));
  assert.equal(server.errors[0]?.code, 'backend_http_error');
  assert.equal(server.errors[0]?.retryable, true);
});

test('searchRor validates cursor state bounds as invalid_input', async () => {
  const outOfRange = encodeResultCursor({ source: 'ror', query: 'q', state: { page: ROR_MAX_PAGE + 1, offset: 0 } });
  const result = await withFetch(
    async () => jsonResponse({ number_of_results: 0, items: [] }),
    () => searchRor({ query: 'q', cursor: outOfRange }),
  );
  assert.equal(result.errors[0]?.code, 'invalid_input');

  const badOffset = encodeResultCursor({ source: 'ror', query: 'q', state: { page: 1, offset: ROR_PAGE_SIZE } });
  const result2 = await withFetch(
    async () => jsonResponse({ number_of_results: 0, items: [] }),
    () => searchRor({ query: 'q', cursor: badOffset }),
  );
  assert.equal(result2.errors[0]?.code, 'invalid_input');
});

test('searchRor rejects cursors bound to another query or source', async () => {
  const otherQuery = encodeResultCursor({ source: 'ror', query: 'other', state: { page: 1, offset: 0 } });
  const result = await withFetch(
    async () => jsonResponse({ number_of_results: 0, items: [] }),
    () => searchRor({ query: 'q', cursor: otherQuery }),
  );
  assert.equal(result.errors[0]?.code, 'invalid_input');
  // Same-query decode failures keep ROR pagination advertised.
  assert.equal(result.pagination.supported, true);

  const otherSource = encodeResultCursor({ source: 'openalex', query: 'q', state: { page: 1, offset: 0 } });
  const cross = await withFetch(
    async () => jsonResponse({ number_of_results: 0, items: [] }),
    () => searchRor({ query: 'q', cursor: otherSource }),
  );
  assert.equal(cross.errors[0]?.code, 'pagination_not_supported');
  // A foreign cursor cannot be resumed, so pagination.supported drops to false.
  assert.equal(cross.pagination.supported, false);
});

test('searchRor clamps bounded limits instead of rejecting them', async () => {
  let captured = '';
  await withFetch(async (input) => {
    captured = String(input);
    return jsonResponse({ number_of_results: 0, items: [] });
  }, () => searchRor({ query: 'q', limit: 500 }));
  // ROR pages are fixed at 20 regardless of the clamped limit.
  assert.equal(new URL(captured).searchParams.get('page'), '1');
  const nonInteger = await withFetch(
    async () => { throw new Error('should not fetch'); },
    () => searchRor({ query: 'q', limit: 2.5 }),
  );
  assert.equal(nonInteger.errors[0]?.code, 'invalid_input');
});

test('searchRor propagates caller aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchRor({ query: 'q', signal: controller.signal }),
    (error: Error) => error.name === 'AbortError',
  );
});
