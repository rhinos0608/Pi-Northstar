import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildNorthstarResult,
  computeStatus,
  decodeResultCursor,
  encodeResultCursor,
  MAX_CURSOR_LENGTH,
  NORTHSTAR_RESULT_SCHEMA,
  NORTHSTAR_RESULT_VERSION,
  parseEntity,
  ResultContractError,
  validateNorthstarEntity,
  validateNorthstarResult,
  type CursorState,
  type NorthstarEntityV1,
} from '../src/result-contract.js';

function workEntity(overrides: Partial<NorthstarEntityV1> = {}): NorthstarEntityV1 {
  return {
    entityVersion: 1,
    kind: 'work',
    id: 'https://openalex.org/W1',
    source: 'openalex',
    title: 'Example work',
    url: 'https://doi.org/10.1234/example',
    ...overrides,
  };
}

// ── Entity parsing (trust-boundary validation) ──

test('parseEntity normalizes a valid provider row', () => {
  const parsed = parseEntity({
    id: 'W1',
    title: 'Example',
    url: 'https://example.com/a',
    snippet: 'An abstract',
    authors: [{ name: 'Ada Example', id: 'A1' }, 'ignored-because-not-an-object'],
    year: 2025,
    citations: 12,
  }, { source: 'openalex', kind: 'work' });

  assert.ok(parsed.ok);
  assert.equal(parsed.entity.kind, 'work');
  assert.equal(parsed.entity.source, 'openalex');
  assert.equal(parsed.entity.entityVersion, 1);
  assert.deepEqual(parsed.entity.authors, [{ name: 'Ada Example', id: 'A1' }]);
  assert.equal(parsed.entity.metrics?.citations, 12);
});

test('parseEntity accepts fallback id/url/snippet field spellings', () => {
  const parsed = parseEntity({
    id: '10.1234/x',
    doi: '10.1234/x',
    title: 'T',
    permalink: 'https://example.com/d',
    abstract: 'Abstract text',
    publicationYear: 2024,
    views: 5,
  }, { source: 'datacite', kind: 'work' });

  assert.ok(parsed.ok);
  assert.equal(parsed.entity.url, 'https://example.com/d');
  assert.equal(parsed.entity.doi, '10.1234/x');
  assert.equal(parsed.entity.year, 2024);
  assert.equal(parsed.entity.metrics?.views, 5);
});

test('parseEntity drops malformed rows with a reason', () => {
  assert.ok(!parseEntity('not an object', { source: 'x', kind: 'work' }).ok);
  assert.ok(!parseEntity({}, { source: 'x', kind: 'work' }).ok);
  assert.ok(!parseEntity({ id: 'a' }, { source: 'x', kind: 'work' }).ok);
  assert.ok(!parseEntity({ id: 'a', url: '' }, { source: 'x', kind: 'work' }).ok);
});

test('parseEntity truncates oversized text fields at the trust boundary', () => {
  const parsed = parseEntity({
    id: 'a',
    url: 'https://example.com',
    title: 'x'.repeat(20_000),
  }, { source: 'x', kind: 'article' });
  assert.ok(parsed.ok);
  assert.equal(parsed.entity.title.length, 8_000);
});

// ── Envelope construction + status precedence ──

test('buildNorthstarResult produces a valid ok envelope', () => {
  const entity = workEntity();
  const result = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', source: 'openalex' },
    outcomes: [{ source: 'openalex', backend: 'openalex-api', entities: [entity] }],
    pagination: { supported: true, limit: 1 },
  });

  const check = validateNorthstarResult(result);
  assert.equal(check.ok, true, check.issues.join('; '));
  assert.equal(result.schema, NORTHSTAR_RESULT_SCHEMA);
  assert.equal(result.version, NORTHSTAR_RESULT_VERSION);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data, { kind: 'entities', entities: [entity] });
  assert.deepEqual(result.sources, [{ source: 'openalex', backend: 'openalex-api', status: 'ok', count: 1 }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pagination.returned, 1);
});

test('status precedence: no entities plus errors is error', () => {
  assert.equal(computeStatus({ entityCount: 0, errorCount: 1, invalidCount: 0, degraded: false }), 'error');
  const result = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', source: 'semantic_scholar' },
    outcomes: [{
      source: 'semantic_scholar',
      backend: 'semantic-scholar-api',
      error: { code: 'invalid_backend_response', message: 'Semantic Scholar response missing data array.', retryable: false },
    }],
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.data, { kind: 'entities', entities: [] });
  assert.equal(result.sources[0]?.status, 'error');
  assert.equal(result.errors[0]?.code, 'invalid_backend_response');
});

test('status precedence: entities plus errors or invalid rows is partial', () => {
  const result = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', source: 'all' },
    outcomes: [
      { source: 'datacite', backend: 'datacite-api', entities: [workEntity({ source: 'datacite', id: '10.1234/example', kind: 'work' })] },
      { source: 'pubmed', backend: 'pubmed-eutils', error: { code: 'rate_limited', message: 'PubMed rate limit exceeded.', retryable: true } },
    ],
    notes: ['Aggregate source pagination is unsupported; choose one exact source to continue.'],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0]?.status, 'ok');
  assert.equal(result.sources[1]?.status, 'error');
  assert.equal(result.errors[0]?.source, 'pubmed');
  assert.equal(result.errors[0]?.retryable, true);
  assert.deepEqual(result.notes, ['Aggregate source pagination is unsupported; choose one exact source to continue.']);
});

test('status precedence: fallback or limited backend is degraded', () => {
  assert.equal(computeStatus({ entityCount: 3, errorCount: 0, invalidCount: 0, degraded: true }), 'degraded');
  const result = buildNorthstarResult({
    request: { tool: 'media', channel: 'youtube', action: 'details' },
    outcomes: [{ source: 'youtube', backend: 'youtube-oembed', entities: [], degraded: true }],
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.sources[0]?.status, 'degraded');
});

test('status precedence: no entities and no errors is empty', () => {
  assert.equal(computeStatus({ entityCount: 0, errorCount: 0, invalidCount: 0, degraded: false }), 'empty');
  const result = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', source: 'wikipedia' },
    outcomes: [{ source: 'wikipedia', backend: 'wikipedia-api', entities: [] }],
  });
  assert.equal(result.status, 'empty');
});

test('invalid rows are reported as invalid_entity and valid siblings survive as partial', () => {
  const result = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', source: 'crossref' },
    outcomes: [{
      source: 'crossref',
      backend: 'crossref-api',
      entities: [workEntity({ source: 'crossref' })],
      invalid: 2,
    }],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.errors.filter((error) => error.code === 'invalid_entity').length, 1);
  assert.equal(result.data.kind === 'entities' ? result.data.entities.length : -1, 1);
});

test('envelope validation rejects malformed envelopes', () => {
  assert.equal(validateNorthstarResult(null).ok, false);
  assert.equal(validateNorthstarResult({ schema: 'wrong', version: 1 }).ok, false);
  assert.equal(validateNorthstarResult({ schema: NORTHSTAR_RESULT_SCHEMA, version: 2 }).ok, false);

  const badEntities = validateNorthstarResult({
    schema: NORTHSTAR_RESULT_SCHEMA,
    version: 1,
    status: 'ok',
    request: { tool: 'web_search', channel: 'research', action: 'search' },
    data: { kind: 'entities', entities: [{ entityVersion: 2, kind: 'work' }] },
    pagination: { supported: false, limit: 0, returned: 0, hasMore: false },
    sources: [],
    errors: [],
    notes: [],
  });
  assert.equal(badEntities.ok, false);
  assert.ok(badEntities.issues.some((issue) => issue.includes('entityVersion')));
  assert.ok(badEntities.issues.some((issue) => issue.includes('url is required')));
});

test('validateNorthstarEntity checks field types', () => {
  assert.equal(validateNorthstarEntity(workEntity()).ok, true);
  const bad = validateNorthstarEntity({ ...workEntity(), metrics: { citations: 'many' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((issue) => issue.includes('metrics.citations')));
});

// ── Cursor binding ──

test('cursors round-trip and bind to source, query, and yearFrom', () => {
  const cursor = encodeResultCursor({ source: 'openalex', query: 'transformer interpretability', yearFrom: 2023, state: { cursorToken: 'abc' } });
  const decoded = decodeResultCursor(cursor, { source: 'openalex', query: 'transformer interpretability', yearFrom: 2023 });
  assert.equal(decoded.source, 'openalex');
  assert.deepEqual(decoded.state, { cursorToken: 'abc' });

  assert.throws(
    () => decodeResultCursor(cursor, { source: 'openalex', query: 'different query', yearFrom: 2023 }),
    (error: unknown) => error instanceof ResultContractError && error.code === 'invalid_input',
  );
  assert.throws(
    () => decodeResultCursor(cursor, { source: 'openalex', query: 'transformer interpretability' }),
    (error: unknown) => error instanceof ResultContractError,
  );
});

test('cursors are rejected for aggregate source and hostile input', () => {
  const cursor = encodeResultCursor({ source: 'openalex', query: 'q', state: {} });
  assert.throws(
    () => decodeResultCursor(cursor, { source: 'all', query: 'q' }),
    (error: unknown) => error instanceof ResultContractError && error.code === 'pagination_not_supported',
  );
  assert.throws(() => decodeResultCursor('', { source: 'openalex', query: 'q' }), /cursor is required/);
  assert.throws(() => decodeResultCursor('not-a-cursor!!', { source: 'openalex', query: 'q' }), /not a valid opaque token/);

  const crossSource = encodeResultCursor({ source: 'arxiv', query: 'q', state: {} });
  assert.throws(
    () => decodeResultCursor(crossSource, { source: 'openalex', query: 'q' }),
    (error: unknown) => error instanceof ResultContractError && error.code === 'pagination_not_supported',
  );
});

test('oversized cursors are rejected before decoding', () => {
  const oversized = 'a'.repeat(MAX_CURSOR_LENGTH + 1);
  assert.throws(() => decodeResultCursor(oversized, { source: 'openalex', query: 'q' }), /maximum length/);
});

test('canonical social entity kinds validate in the shared envelope', () => {
  for (const kind of [
    'social_post', 'social_comment', 'social_account', 'social_thread',
    'social_community', 'social_media', 'social_relationship', 'social_engagement',
    'social_topic', 'social_notification', 'social_reference',
  ] as const) {
    const check = validateNorthstarEntity({
      ...workEntity(),
      kind,
      id: `id-${kind}`,
      source: 'twitter',
      title: 'Social row',
    });
    assert.equal(check.ok, true, `${kind}: ${check.issues.join('; ')}`);
  }
  assert.equal(
    validateNorthstarEntity({ ...workEntity(), kind: 'social_profile' }).ok,
    false,
    'renamed social_profile must no longer validate',
  );
});

test('cursor state rejects non-scalar values (no nested objects or URLs)', () => {
  const hostile = encodeResultCursor({
    source: 'openalex',
    query: 'q',
    state: { url: { nested: true } } as unknown as CursorState,
  });
  assert.throws(
    () => decodeResultCursor(hostile, { source: 'openalex', query: 'q' }),
    (error: unknown) => error instanceof ResultContractError && error.code === 'invalid_input',
  );
});
