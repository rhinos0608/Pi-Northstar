import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GRAPH_LANGUAGES,
  buildGraphResult,
  decodeGraphCursor,
  encodeGraphCursor,
  fingerprintGraphRequest,
  validateGraphRequest,
  validateGraphResult,
  GRAPH_RESULT_SCHEMA,
  GRAPH_RESULT_VERSION,
} from '../../src/graph/graph-contract.js';

// Slice 1: canonical language registry; DQL defaults preserved; SPARQL query accepted.
test('canonical graph languages are dql and sparql', () => {
  assert.deepEqual([...GRAPH_LANGUAGES], ['dql', 'sparql']);
});

test('dql query keeps default pageSize 10', () => {
  const out = validateGraphRequest({ action: 'query', language: 'dql', query: 'type:Organization' });
  assert.equal(out.ok, true);
  if (out.ok && out.input.action === 'query' && out.input.language === 'dql') {
    assert.equal(out.input.pageSize, 10);
  } else {
    assert.fail('expected dql query input');
  }
});

test('sparql query rejects pageSize and cursor', () => {
  for (const input of [
    { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }', pageSize: 10 },
    { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }', cursor: 'opaque' },
    { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }', bogus: 1 },
  ]) {
    const out = validateGraphRequest(input);
    assert.equal(out.ok, false, JSON.stringify(input));
    if (!out.ok) assert.equal(out.code, 'invalid_input');
  }
  assert.equal(validateGraphRequest({ action: 'query', language: 'sparql', query: '   ' }).ok, false);
});

test('probe accepts either language and preserves it', () => {
  for (const language of ['dql', 'sparql'] as const) {
    const out = validateGraphRequest({ action: 'probe', language, queries: ['a', 'b'] });
    assert.equal(out.ok, true);
    if (out.ok && out.input.action === 'probe') {
      assert.equal(out.input.language, language);
      assert.deepEqual(out.input.queries, ['a', 'b']);
    } else {
      assert.fail('expected probe input');
    }
  }
  assert.equal(validateGraphRequest({ action: 'probe', language: 'sparql', queries: ['a'], pageSize: 5 }).ok, false);
});

test('schema accepts either language with unchanged selector semantics', () => {
  for (const language of ['dql', 'sparql'] as const) {
    assert.equal(validateGraphRequest({ action: 'schema', language, view: 'types' }).ok, true);
    const described = validateGraphRequest({ action: 'schema', language, view: 'describe', name: 'Person' });
    assert.equal(described.ok, true);
    if (described.ok && described.input.action === 'schema') assert.equal(described.input.language, language);
    assert.equal(validateGraphRequest({ action: 'schema', language, view: 'describe' }).ok, false);
    assert.equal(validateGraphRequest({ action: 'schema', language, view: 'search', query: 'pers' }).ok, true);
    assert.equal(validateGraphRequest({ action: 'schema', language, view: 'types', name: 'Person' }).ok, false);
  }
});

test('cursor codec stays DQL-only and byte-compatible', () => {
  const cursor = encodeGraphCursor({
    provider: 'diffbot', fingerprint: fingerprintGraphRequest({ q: 1 }),
    adapterCursorV: 1, action: 'query', language: 'dql', pageSize: 10, state: { from: 10 },
  });
  const decoded = decodeGraphCursor(cursor);
  assert.equal(decoded.language, 'dql');
  assert.equal(decoded.v, 1);
  assert.throws(() => encodeGraphCursor({
    provider: 'diffbot', fingerprint: 'abc123',
    adapterCursorV: 1, action: 'query', language: 'sparql', pageSize: 10, state: {},
  }), /cursor/);
  const sparqlPayload = Buffer.from(JSON.stringify({
    v: 1, provider: 'diffbot', fingerprint: 'abc123', adapterCursorV: 1,
    action: 'query', language: 'sparql', pageSize: 10, state: {},
  }), 'utf8').toString('base64url');
  assert.throws(() => decodeGraphCursor(sparqlPayload), /cursor/);
});

test('result validation accepts both languages with unchanged v1 envelope', () => {
  for (const language of ['dql', 'sparql'] as const) {
    const envelope = {
      schema: GRAPH_RESULT_SCHEMA, version: GRAPH_RESULT_VERSION, status: 'ok',
      language, source: { provider: 'diffbot' },
      data: { kind: 'query', shape: 'rows', result: [{ a: 1 }] },
      errors: [], notes: [],
    };
    assert.equal(validateGraphResult(envelope).ok, true, language);
    const built = buildGraphResult({
      status: 'ok', language, provider: 'diffbot',
      data: { kind: 'query', shape: 'rows', result: [{ a: 1 }] },
    });
    assert.equal(built.language, language);
    assert.equal(built.schema, GRAPH_RESULT_SCHEMA);
    assert.equal(built.version, 1);
  }
  assert.equal(validateGraphResult({
    schema: GRAPH_RESULT_SCHEMA, version: GRAPH_RESULT_VERSION, status: 'ok',
    language: 'sql', source: { provider: 'diffbot' },
    data: { kind: 'query', shape: 'rows', result: [] },
    errors: [], notes: [],
  }).ok, false);
});

test('schema fields/describe reject name longer than MAX_GRAPH_NAME_CHARS', async () => {
  const { MAX_GRAPH_NAME_CHARS } = await import('../../src/graph/graph-contract.js');
  assert.equal(MAX_GRAPH_NAME_CHARS, 2000);
  const longName = 'a'.repeat(MAX_GRAPH_NAME_CHARS + 1);
  for (const view of ['fields', 'describe'] as const) {
    const out = validateGraphRequest({ action: 'schema', language: 'dql', view, name: longName });
    assert.equal(out.ok, false, view);
    if (!out.ok) assert.equal(out.code, 'invalid_input');
  }
});
