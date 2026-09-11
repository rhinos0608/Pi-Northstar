import assert from 'node:assert/strict';
import { promises as dnsPromises } from 'node:dns';
import { test } from 'node:test';
import { ResearchHttpError } from '../src/research-adapter-shared.js';
import {
  MAX_RESEARCH_LIMIT,
  cursorErrorEnvelope,
  cursorNumber,
  cursorToken,
  decodeCursorState,
  envApiKey,
  fetchResearchJson,
  httpOutcomeError,
  normalizeResearchInput,
  parseAdapterRows,
  rejectedInputEnvelope,
  researchRequestV1,
} from '../src/research-adapter-shared.js';
import { encodeResultCursor } from '../src/result-contract.js';

test('normalizeResearchInput clamps limit and validates query/yearFrom', () => {
  assert.equal(normalizeResearchInput({ query: '  x ' }).ok, true);
  const clamped = normalizeResearchInput({ query: 'q', limit: 999 });
  assert.ok(clamped.ok && clamped.input.limit === MAX_RESEARCH_LIMIT);
  const floor = normalizeResearchInput({ query: 'q', limit: 0 });
  assert.ok(floor.ok && floor.input.limit === 1);
  assert.equal(normalizeResearchInput({ query: '   ' }).ok, false);
  assert.equal(normalizeResearchInput({ query: 'q', limit: 2.5 }).ok, false);
  assert.equal(normalizeResearchInput({ query: 'q', yearFrom: 42 }).ok, false);
  const year = normalizeResearchInput({ query: 'q', yearFrom: 2020 });
  assert.ok(year.ok && year.input.yearFrom === 2020);
});

test('envApiKey trims and treats blank as absent', () => {
  assert.equal(envApiKey({ K: '  tok  ' }, 'K'), 'tok');
  assert.equal(envApiKey({ K: '   ' }, 'K'), undefined);
  assert.equal(envApiKey({}, 'K'), undefined);
});

test('fetchResearchJson sanitizes http.ts error URLs into status-only failures', async () => {
  const savedFetch = globalThis.fetch;
  const savedLookup = dnsPromises.lookup;
  globalThis.fetch = async () => {
    throw new Error('HTTP 500 for https://example.com/path?secret=leak-me');
  };
  // Stub DNS preflight with an allowed public address: no public-DNS reliance.
  (dnsPromises as { lookup: unknown }).lookup = async () => [{ address: '93.184.215.14', family: 4 }];
  try {
    await assert.rejects(fetchResearchJson('https://example.com/path', {}), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { status?: number }).status, 500);
      assert.doesNotMatch((error as Error).message, /leak-me/);
      return true;
    });
  } finally {
    (dnsPromises as { lookup: unknown }).lookup = savedLookup;
    globalThis.fetch = savedFetch;
  }
});

test('httpOutcomeError maps sanitized failures to contract codes', () => {
  assert.deepEqual(httpOutcomeError(new ResearchHttpError('timeout', 'sanitized')), { code: 'timeout', message: 'Research request timed out.', retryable: true });
  assert.deepEqual(httpOutcomeError(new ResearchHttpError('http', 'sanitized', 429)).code, 'rate_limited');
  const server = httpOutcomeError(new ResearchHttpError('http', 'sanitized', 500));
  assert.equal(server.code, 'backend_http_error');
  assert.equal(server.retryable, true);
  const client = httpOutcomeError(new ResearchHttpError('http', 'sanitized', 403));
  assert.equal(client.retryable, false);
  const network = httpOutcomeError(new ResearchHttpError('network', 'sanitized'));
  assert.equal(network.code, 'backend_unavailable');
});

test('decodeCursorState binds to source/query and rejects foreign cursors', () => {
  const cursor = encodeResultCursor({ source: 'openalex', query: 'q', yearFrom: 2020, state: { cursor: 'abc' } });
  const decoded = decodeCursorState(cursor, { source: 'openalex', query: 'q', yearFrom: 2020 });
  assert.ok(decoded.ok && decoded.state.cursor === 'abc');
  const wrongSource = decodeCursorState(cursor, { source: 'pubmed', query: 'q', yearFrom: 2020 });
  assert.ok(!wrongSource.ok && wrongSource.error.code === 'pagination_not_supported');
  const wrongQuery = decodeCursorState(cursor, { source: 'openalex', query: 'other', yearFrom: 2020 });
  assert.ok(!wrongQuery.ok && wrongQuery.error.code === 'invalid_input');
  const all = decodeCursorState('x', { source: 'all', query: 'q' });
  assert.ok(!all.ok && all.error.code === 'pagination_not_supported');
});

test('cursor state accessors enforce bounds', () => {
  assert.ok(cursorNumber({ offset: 5 }, 'offset', 0, 10).ok);
  assert.equal(cursorNumber({ offset: 50 }, 'offset', 0, 10).ok, false);
  assert.equal(cursorNumber({}, 'offset', 0, 10).ok, false);
  assert.equal(cursorNumber({ offset: '5' }, 'offset', 0, 10).ok, false);
  assert.ok(cursorToken({ cursor: 'tok' }, 'cursor').ok);
  assert.equal(cursorToken({ cursor: '' }, 'cursor').ok, false);
  assert.equal(cursorToken({ cursor: 'x'.repeat(600) }, 'cursor').ok, false);
});

test('parseAdapterRows drops malformed rows and keeps valid siblings', () => {
  const rows = parseAdapterRows(
    [
      { id: 'a', url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: 'no id' },
      'not-an-object',
    ],
    'test',
    'work',
  );
  assert.equal(rows.entities.length, 1);
  assert.equal(rows.invalid, 2);
  assert.equal(rows.entities[0]?.id, 'a');
});

test('rejectedInputEnvelope produces an invalid_input error envelope', () => {
  const envelope = rejectedInputEnvelope(
    researchRequestV1('datacite', { requestedAction: 'search' }),
    'datacite',
    'datacite-api',
    'no venue here',
    10,
  );
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.errors[0]?.code, 'invalid_input');
  assert.equal(envelope.request.source, 'datacite');
  assert.equal(envelope.request.requestedAction, 'search');
});

test('rejectedInputEnvelope reports pagination unsupported for sources without pagination', () => {
  const wiki = rejectedInputEnvelope(
    researchRequestV1('wikipedia', { requestedAction: 'search' }),
    'wikipedia',
    'wikipedia-api',
    'no filters here',
    10,
  );
  assert.equal(wiki.pagination.supported, false);

  const gdelt = rejectedInputEnvelope(
    researchRequestV1('gdelt', { requestedAction: 'search' }),
    'gdelt',
    'gdelt-api',
    'no filters here',
    10,
  );
  assert.equal(gdelt.pagination.supported, false);

  // Pagination-capable sources keep supported: true on filter errors.
  const dataciteError = rejectedInputEnvelope(
    researchRequestV1('datacite', { requestedAction: 'search' }),
    'datacite',
    'datacite-api',
    'no venue here',
    10,
  );
  assert.equal(dataciteError.pagination.supported, true);
});

test('cursorErrorEnvelope derives pagination support from the capability registry', () => {
  const invalidInput = { code: 'invalid_input' as const, message: 'bad cursor', retryable: false };
  const notSupported = { code: 'pagination_not_supported' as const, message: 'foreign cursor', retryable: false };

  // A pagination-capable source keeps support advertised on plain decode failures.
  const ror = cursorErrorEnvelope(researchRequestV1('ror'), 'ror', 'ror-api', 10, invalidInput);
  assert.equal(ror.pagination.supported, true);

  // A foreign cursor (pagination_not_supported) never advertises resumability.
  const rorForeign = cursorErrorEnvelope(researchRequestV1('ror'), 'ror', 'ror-api', 10, notSupported);
  assert.equal(rorForeign.pagination.supported, false);

  // A source whose registry pagination is unsupported never advertises support,
  // even if it somehow routed a plain decode failure through this path.
  const gdelt = cursorErrorEnvelope(researchRequestV1('gdelt'), 'gdelt', 'gdelt-api', 10, invalidInput);
  assert.equal(gdelt.pagination.supported, false);
});

test('normalizeResearchInput accepts yearTo and enforces filter length caps', () => {
  const both = normalizeResearchInput({ query: 'q', yearFrom: 2020, yearTo: 2024 });
  assert.ok(both.ok && both.input.yearFrom === 2020 && both.input.yearTo === 2024);
  assert.equal(normalizeResearchInput({ query: 'q', yearTo: 42 }).ok, false);
  const inverted = normalizeResearchInput({ query: 'q', yearFrom: 2024, yearTo: 2020 });
  assert.ok(!inverted.ok);
  assert.equal(normalizeResearchInput({ query: 'q', author: 'x'.repeat(201) }).ok, false);
  assert.equal(normalizeResearchInput({ query: 'q', doi: 'x'.repeat(101) }).ok, false);
  assert.equal(normalizeResearchInput({ query: 'q', venue: 'x'.repeat(201) }).ok, false);
  const boundary = normalizeResearchInput({ query: 'q', author: 'x'.repeat(200), doi: 'x'.repeat(100), venue: 'x'.repeat(200) });
  assert.ok(boundary.ok);
});

test('isSupportedResearchAction admits only the canonical action and its legacy alias', async () => {
  const { isSupportedResearchAction, RESEARCH_CANONICAL_ACTION } = await import('../src/research-adapter-shared.js');
  assert.equal(RESEARCH_CANONICAL_ACTION, 'search');
  assert.ok(isSupportedResearchAction('search'));
  assert.ok(isSupportedResearchAction('academic'));
  assert.equal(isSupportedResearchAction('lookup'), false);
  assert.equal(isSupportedResearchAction(''), false);
});

test('parseAdapterRows output passes strict entity validation; failures count invalid', async () => {
  const { validateNorthstarEntity } = await import('../src/result-contract.js');
  const rows = parseAdapterRows(
    [
      { id: 'a', url: 'https://example.com/a', title: 'A', authors: [{ name: 'Ada' }], year: 2020 },
      { url: 'https://example.com/b', title: 'no id' },
      { id: 'c', title: 'no url' },
    ],
    'test',
    'work',
  );
  assert.equal(rows.entities.length, 1);
  assert.equal(rows.invalid, 2);
  for (const entity of rows.entities) {
    assert.ok(validateNorthstarEntity(entity).ok, JSON.stringify(entity));
    assert.equal(entity.kind, 'work');
  }
});
