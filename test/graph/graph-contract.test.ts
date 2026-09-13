import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fingerprintGraphRequest,
  validateGraphRequest,
  validateGraphResult,
  decodeGraphCursor,
  encodeGraphCursor,
  buildGraphResult,
  GRAPH_RESULT_SCHEMA,
  GRAPH_RESULT_VERSION,
  MAX_GRAPH_CURSOR_LENGTH,
} from '../../src/graph/graph-contract.js';

// ── query action ──

test('query accepts minimal valid request with defaults', () => {
  const out = validateGraphRequest({ action: 'query', language: 'dql', query: 'type:Organization name:"Acme"' });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.input.action, 'query');
    if (out.input.language !== 'dql') throw new Error('expected dql');
    assert.equal(out.input.pageSize, 10);
  }
});

test('query dql keeps pageSize/cursor', () => {
  const dql = validateGraphRequest({ action: 'query', language: 'dql', query: 'type:Organization', pageSize: 25 });
  assert.equal(dql.ok, true);
  if (!dql.ok) throw new Error('expected ok');
  assert.equal(dql.input.action, 'query');
  if (dql.input.action !== 'query' || dql.input.language !== 'dql') throw new Error('expected dql query input');
  assert.equal(dql.input.pageSize, 25);
});

test('query sparql accepts bare query but rejects pageSize/cursor', () => {
  const sparql = validateGraphRequest({ action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }' });
  assert.equal(sparql.ok, true);
  if (sparql.ok) assert.equal(sparql.input.language, 'sparql');
  for (const input of [
    { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }', pageSize: 10 },
    { action: 'query', language: 'sparql', query: 'SELECT * WHERE { ?s ?p ?o }', cursor: 'opaque' },
  ]) {
    const out = validateGraphRequest(input);
    assert.equal(out.ok, false, JSON.stringify(input));
    if (!out.ok) assert.equal(out.code, 'invalid_input');
  }
});


test('query rejects missing language and non-dql language', () => {
  for (const input of [
    { action: 'query', query: 'type:Organization' },
    { action: 'query', language: 'sql', query: 'type:Organization' },
  ]) {
    const out = validateGraphRequest(input);
    assert.equal(out.ok, false, JSON.stringify(input));
    if (!out.ok) assert.equal(out.code, 'unsupported_option');
  }
});

test('query rejects unknown keys and cross-action fields', () => {
  for (const input of [
    { action: 'query', language: 'dql', query: 'type:Organization', bogus: 1 },
    { action: 'query', language: 'dql', query: 'type:Organization', queries: ['a'] },
    { action: 'query', language: 'dql', query: 'type:Organization', view: 'types' },
    { action: 'query', language: 'dql', query: 'type:Organization', provider: 'diffbot' },
    { action: 'query', language: 'dql', query: 'type:Organization', workers: 4 },
    { action: 'query', language: 'dql', query: 'type:Organization', refresh: true },
    { action: 'query', language: 'dql', query: 'type:Organization', format: 'csv' },
  ]) {
    const out = validateGraphRequest(input);
    assert.equal(out.ok, false, JSON.stringify(input));
  }
});

test('query enforces length and pageSize bounds', () => {
  assert.equal(validateGraphRequest({ action: 'query', language: 'dql', query: '   ' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'query', language: 'dql', query: 'x'.repeat(50_001) }).ok, false);
  assert.equal(validateGraphRequest({ action: 'query', language: 'dql', query: 'ok', pageSize: 0 }).ok, false);
  assert.equal(validateGraphRequest({ action: 'query', language: 'dql', query: 'ok', pageSize: 101 }).ok, false);
  assert.equal(validateGraphRequest({ action: 'query', language: 'dql', query: 'ok', pageSize: 1.5 }).ok, false);
  const ok = validateGraphRequest({ action: 'query', language: 'dql', query: 'ok', pageSize: 25 });
  assert.equal(ok.ok, true);
});

test('query rejects oversize cursor before adapter dispatch', () => {
  const out = validateGraphRequest({ action: 'query', language: 'dql', query: 'ok', cursor: 'x'.repeat(4097) });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.code, 'cursor_invalid');
});

// ── probe action ──

test('probe accepts 1..32 queries and preserves order', () => {
  const out = validateGraphRequest({ action: 'probe', language: 'dql', queries: ['a', 'b'] });
  assert.equal(out.ok, true);
  if (out.ok && out.input.action === 'probe') assert.deepEqual(out.input.queries, ['a', 'b']);
  assert.equal(validateGraphRequest({ action: 'probe', language: 'dql', queries: [] }).ok, false);
  assert.equal(validateGraphRequest({ action: 'probe', language: 'dql', queries: Array(33).fill('x') }).ok, false);
  assert.equal(validateGraphRequest({ action: 'probe', language: 'dql', queries: [''] }).ok, false);
  assert.equal(validateGraphRequest({ action: 'probe', language: 'dql', queries: ['x'.repeat(50_001)] }).ok, false);
});

test('probe rejects cursor/pageSize/query cross-action fields', () => {
  assert.equal(validateGraphRequest({ action: 'probe', language: 'dql', queries: ['a'], cursor: 'x' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'probe', language: 'dql', queries: ['a'], pageSize: 5 }).ok, false);
  assert.equal(validateGraphRequest({ action: 'probe', language: 'dql', queries: ['a'], query: 'a' }).ok, false);
});

// ── schema action ──

test('schema validates view selectors', () => {
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'types' }).ok, true);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'fields' }).ok, true);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'describe' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'describe', name: 'Person' }).ok, true);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'search' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'search', query: 'pers' }).ok, true);
  // irrelevant selectors rejected
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'types', name: 'Person' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'types', query: 'x' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'fields', query: 'x' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'describe', query: 'x' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'bogus' }).ok, false);
});

test('schema includeDeprecated must be boolean when present', () => {
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'types', includeDeprecated: 'yes' }).ok, false);
  assert.equal(validateGraphRequest({ action: 'schema', language: 'dql', view: 'types', includeDeprecated: true }).ok, true);
});

// ── JsonValue bounds ──

test('result validation rejects recursive JSON overflow without truncation', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  const envelope = {
    schema: GRAPH_RESULT_SCHEMA, version: GRAPH_RESULT_VERSION, status: 'ok',
    language: 'dql', source: { provider: 'diffbot' },
    data: { kind: 'query', shape: 'rows', result: deep },
    errors: [], notes: [],
  };
  assert.equal(validateGraphResult(envelope).ok, false);
  const wide: Record<string, number> = {};
  for (let i = 0; i < 1001; i++) wide[`k${i}`] = i;
  assert.equal(validateGraphResult({
    schema: GRAPH_RESULT_SCHEMA, version: GRAPH_RESULT_VERSION, status: 'ok',
    language: 'dql', source: { provider: 'diffbot' },
    data: { kind: 'query', shape: 'object', result: wide },
    errors: [], notes: [],
  }).ok, false);
  const longArr = Array(10_001).fill(1);
  assert.equal(validateGraphResult({
    schema: GRAPH_RESULT_SCHEMA, version: GRAPH_RESULT_VERSION, status: 'ok',
    language: 'dql', source: { provider: 'diffbot' },
    data: { kind: 'query', shape: 'rows', result: longArr },
    errors: [], notes: [],
  }).ok, false);
});

// ── envelope build/validate ──

test('buildGraphResult fails closed on malformed results', () => {
  assert.throws(() => buildGraphResult({
    language: 'dql', source: { provider: 'diffbot' },
    // @ts-expect-error probe coverage: invalid data kind
    data: { kind: 'bogus' },
    errors: [], notes: [],
  }), /contract/);
});

test('cursor round-trip binds action/language/provider/query/pageSize/adapter version', () => {
  const cursor = encodeGraphCursor({
    provider: 'diffbot', fingerprint: fingerprintGraphRequest({ q: 1 }),
    adapterCursorV: 1, action: 'query', language: 'dql', pageSize: 10, state: { from: 10 },
  });
  assert.ok(cursor.length <= MAX_GRAPH_CURSOR_LENGTH);
  const decoded = decodeGraphCursor(cursor);
  assert.equal(decoded.provider, 'diffbot');
  assert.equal(decoded.action, 'query');
  // every binding mismatch surfaces via pinned decode in graph-tools; codec itself validates hostility:
  assert.throws(() => decodeGraphCursor('not-a-cursor!!'), /cursor/);
  assert.throws(() => decodeGraphCursor('x'.repeat(4097)), /cursor/);
});
