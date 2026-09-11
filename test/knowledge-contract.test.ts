import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildKnowledgeResult,
  decodeKgCursor,
  encodeKgCursor,
  KNOWLEDGE_RESULT_SCHEMA,
  KNOWLEDGE_RESULT_VERSION,
  normalizeOntologyTerm,
  parseKgEntity,
  validateKgEnhance,
  validateKgNlp,
  validateKgSearch,
  validateKnowledgeResult,
} from '../src/knowledge-contract.js';

function kgEntity(id = 'e1') {
  return {
    entityVersion: 1 as const,
    id,
    type: 'Person' as const,
    name: 'Ada Lovelace',
    url: 'https://example.com/ada',
  };
}

// ── Envelope precedence ──

test('knowledge envelope carries v1 schema marker', () => {
  const result = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search', provider: 'diffbot' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
  });
  assert.equal(result.schema, KNOWLEDGE_RESULT_SCHEMA);
  assert.equal(result.schema, 'pi-northstar.knowledge-result');
  assert.equal(result.version, KNOWLEDGE_RESULT_VERSION);
  assert.equal(result.version, 1);
  assert.equal(result.status, 'ok');
  assert.equal(validateKnowledgeResult(result).ok, true);
});

test('status precedence: entities plus errors is partial', () => {
  const result = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [
      { provider: 'diffbot', entities: [kgEntity()] },
      { provider: 'other', error: { code: 'upstream_error', message: 'boom', retryable: true } },
    ],
  });
  assert.equal(result.status, 'partial');
});

test('status precedence: fallback outcome is degraded', () => {
  const result = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()], degraded: true }],
  });
  assert.equal(result.status, 'degraded');
});

test('status precedence: no entities and no errors is empty', () => {
  const result = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'diffbot', entities: [] }],
  });
  assert.equal(result.status, 'empty');
});

test('all-invalid rows become error, valid siblings survive as partial', () => {
  const rows = [{ nope: true }, kgEntity(), { id: '', type: 'Person' }];
  const entities = [];
  let invalid = 0;
  for (const row of rows) {
    const parsed = parseKgEntity(row, 'diffbot');
    if (parsed.ok) entities.push(parsed.entity);
    else {
      assert.equal(parsed.code, 'invalid_entity');
      invalid += 1;
    }
  }
  assert.equal(entities.length, 1);
  const partial = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'diffbot', entities, invalid }],
  });
  assert.equal(partial.status, 'partial');
  const allInvalid = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'diffbot', entities: [], invalid: 2 }],
  });
  assert.equal(allInvalid.status, 'error');
});

test('validateKnowledgeResult fails closed on malformed envelope', () => {
  assert.equal(validateKnowledgeResult(null).ok, false);
  assert.equal(validateKnowledgeResult({ schema: 'wrong' }).ok, false);
  const result = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
  });
  const tampered = { ...result, status: 'bogus' };
  assert.equal(validateKnowledgeResult(tampered).ok, false);
});

// ── Search validator ──

test('validateKgSearch requires DQL string with fixed language', () => {
  assert.equal(validateKgSearch({ query: 'type:Person AND name:"Ada"', language: 'dql' }).ok, true);
  assert.equal(validateKgSearch({ query: '', language: 'dql' }).ok, false);
  const wrongLang = validateKgSearch({ query: 'type:Person', language: 'sql' });
  assert.equal(wrongLang.ok, false);
  if (!wrongLang.ok) assert.equal(wrongLang.code, 'unsupported_option');
});

test('validateKgSearch rejects facet/report/export/collection/crawl modes', () => {
  for (const query of [
    'type:Person facet:employer',
    'report on hiring trends',
    'export format=csv type:Person',
    'from collection:people type:Person',
    'crawl:https://example.com',
  ]) {
    const parsed = validateKgSearch({ query, language: 'dql' });
    assert.equal(parsed.ok, false, query);
    if (!parsed.ok) assert.equal(parsed.code, 'unsupported_option', query);
  }
});

// ── Enhance validator ──

test('validateKgEnhance rejects missing selectors', () => {
  const parsed = validateKgEnhance({ type: 'Person' });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, 'invalid_input');
});

test('validateKgEnhance accepts type plus one selector', () => {
  assert.equal(validateKgEnhance({ type: 'Person', name: 'Ada Lovelace' }).ok, true);
  assert.equal(validateKgEnhance({ type: 'Organization', url: 'https://example.com' }).ok, true);
});

test('validateKgEnhance rejects Person-only selectors on Organization', () => {
  for (const extra of [{ employer: 'x' }, { title: 'x' }, { school: 'x' }]) {
    const parsed = validateKgEnhance({ type: 'Organization', name: 'Acme', ...extra });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.code, 'invalid_input');
  }
});

test('validateKgEnhance rejects bad portable options', () => {
  assert.equal(validateKgEnhance({ type: 'Person', name: 'Ada', fields: 'nope' }).ok, false);
  assert.equal(validateKgEnhance({ type: 'Person', name: 'Ada', confidenceThreshold: 2 }).ok, false);
  assert.equal(validateKgEnhance({ type: 'Person', name: 'Ada', maxEntities: 0 }).ok, false);
  assert.equal(validateKgEnhance({ type: 'Frog', name: 'Ada' }).ok, false);
});

// ── NLP validator ──

test('validateKgNlp rejects 0 and 100001 chars, never clamps', () => {
  assert.equal(validateKgNlp({ text: '' }).ok, false);
  assert.equal(validateKgNlp({ text: 'x'.repeat(100001) }).ok, false);
  assert.equal(validateKgNlp({ text: 'hello' }).ok, true);
  assert.equal(validateKgNlp({ text: 'x'.repeat(100000) }).ok, true);
});

test('validateKgNlp rejects bad language and non-boolean flags', () => {
  assert.equal(validateKgNlp({ text: 'hi', language: 'english' }).ok, false);
  assert.equal(validateKgNlp({ text: 'hi', language: 'auto' }).ok, true);
  assert.equal(validateKgNlp({ text: 'hi', language: 'en' }).ok, true);
  assert.equal(validateKgNlp({ text: 'hi', extractEntities: 'yes' }).ok, false);
});

// ── Cursor codec ──

test('cursor round-trips, tamper and hostile fields rejected', () => {
  const cursor = encodeKgCursor({
    provider: 'diffbot',
    fingerprint: 'abc123',
    adapterCursorV: 1,
    state: { from: 10 },
  });
  const decoded = decodeKgCursor(cursor);
  assert.equal(decoded.provider, 'diffbot');
  assert.equal(decoded.fingerprint, 'abc123');
  assert.throws(() => decodeKgCursor(`${cursor}tampered`), /cursor/i);
  assert.throws(() => decodeKgCursor('not-base64!!!@@@###'), /cursor/i);
  const hostile = Buffer.from(
    JSON.stringify({ v: 1, provider: 'diffbot', fingerprint: 'x', adapterCursorV: 1, state: { nested: {} } }),
    'utf8',
  ).toString('base64url');
  assert.throws(() => decodeKgCursor(hostile), /cursor/i);
  const wrongVersion = Buffer.from(
    JSON.stringify({ v: 99, provider: 'diffbot', fingerprint: 'x', adapterCursorV: 1, state: {} }),
    'utf8',
  ).toString('base64url');
  assert.throws(() => decodeKgCursor(wrongVersion), /cursor/i);
});

// ── Ontology namespacing ──

test('unknown ontology terms are diffbot-namespaced', () => {
  assert.equal(normalizeOntologyTerm('Person', ['Person', 'Organization']), 'Person');
  assert.equal(normalizeOntologyTerm('Founder', ['Person', 'Organization']), 'diffbot:Founder');
});

test('enhance envelope validation accepts provider-traced claims, rejects raw payload keys', () => {
  const result = buildKnowledgeResult({
    request: { tool: 'kg', action: 'enhance' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
    data: {
      kind: 'enhance',
      entities: [kgEntity()],
      claims: [{ subjectId: 'e1', predicate: 'employer', object: 'Acme', provider: 'diffbot' }],
      conflicts: [],
      partitions: [{ provider: 'diffbot', status: 'ok' }],
    },
  });
  assert.equal(validateKnowledgeResult(result).ok, true);
  const withRaw = { ...result, data: { ...result.data, raw: [{ secret: 1 }] } };
  assert.equal(validateKnowledgeResult(withRaw).ok, false);
  const badClaim = { ...result, data: { ...(result.data as { kind: 'enhance' }), claims: [{ subjectId: '', predicate: '' }] } };
  assert.equal(validateKnowledgeResult(badClaim).ok, false);
});

test('enhance envelope rejects raw claim keys, non-enum basis/strength, unbounded confidence, bad members', () => {
  const good = buildKnowledgeResult({
    request: { tool: 'kg', action: 'enhance' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
    data: {
      kind: 'enhance',
      entities: [kgEntity()],
      claims: [{ subjectId: 'e1', predicate: 'employer', object: 'Acme', provider: 'diffbot' }],
      conflicts: [],
      partitions: [{ provider: 'diffbot', status: 'ok' }],
    },
  });
  assert.equal(validateKnowledgeResult(good).ok, true);
  const rawClaim = {
    ...good,
    data: {
      ...(good.data as { kind: 'enhance' }),
      claims: [{ subjectId: 'e1', predicate: 'p', object: 'o', rawUpstream: { secret: 1 } }],
    },
  };
  assert.equal(validateKnowledgeResult(rawClaim).ok, false);
  const badGroup = {
    ...good,
    data: {
      ...(good.data as { kind: 'enhance' }),
      groups: [{ key: 'k', basis: 'not-a-basis', strength: 'x', alignmentConfidence: 9, members: [{ entity: 'nope', provider: '' }] }],
    },
  };
  assert.equal(validateKnowledgeResult(badGroup).ok, false);
});

test('search and analyze_text envelopes reject raw payload keys', () => {
  const search = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
  });
  assert.equal(validateKnowledgeResult(search).ok, true);
  const rawSearch = { ...search, data: { ...(search.data as object), rawProviderPayload: { a: 1 }, bogus: 1 } };
  assert.equal(validateKnowledgeResult(rawSearch).ok, false);
  const nlp = buildKnowledgeResult({
    request: { tool: 'kg', action: 'analyze_text' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
    data: {
      kind: 'analyze_text',
      entities: [kgEntity()],
      mentions: [],
      facts: [],
      topics: [],
      partitions: [{ provider: 'diffbot', status: 'ok' }],
    },
  });
  assert.equal(validateKnowledgeResult(nlp).ok, true);
  const rawNlp = { ...nlp, data: { ...(nlp.data as object), rawProviderPayload: { a: 1 } } };
  assert.equal(validateKnowledgeResult(rawNlp).ok, false);
});

test('public groups use opaque id, key rejected', () => {
  const base = buildKnowledgeResult({
    request: { tool: 'kg', action: 'enhance' },
    outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
    data: {
      kind: 'enhance',
      entities: [kgEntity()],
      claims: [{ subjectId: 'alignment:1', predicate: 'employer', object: 'Acme', provider: 'diffbot' }],
      conflicts: [],
      partitions: [{ provider: 'diffbot', status: 'ok' }],
      groups: [
        {
          id: 'alignment:1',
          basis: 'canonical_url',
          strength: 'exact',
          members: [{ entity: kgEntity(), provider: 'diffbot' }],
        },
      ],
    },
  });
  assert.equal(validateKnowledgeResult(base).ok, true);
  const withKey = {
    ...base,
    data: {
      ...(base.data as { kind: 'enhance' }),
      groups: [
        {
          key: 'canonical_url:https://example.com/ada',
          basis: 'canonical_url',
          strength: 'exact',
          members: [{ entity: kgEntity(), provider: 'diffbot' }],
        },
      ],
    },
  };
  assert.equal(validateKnowledgeResult(withKey).ok, false);
  const withBoth = {
    ...base,
    data: {
      ...(base.data as { kind: 'enhance' }),
      groups: [
        {
          id: 'alignment:1',
          key: 'canonical_url:https://example.com/ada',
          basis: 'canonical_url',
          strength: 'exact',
          members: [{ entity: kgEntity(), provider: 'diffbot' }],
        },
      ],
    },
  };
  assert.equal(validateKnowledgeResult(withBoth).ok, false);
  const withEmptyId = {
    ...base,
    data: {
      ...(base.data as { kind: 'enhance' }),
      groups: [
        {
          id: '',
          basis: 'canonical_url',
          strength: 'exact',
          members: [{ entity: kgEntity(), provider: 'diffbot' }],
        },
      ],
    },
  };
  assert.equal(validateKnowledgeResult(withEmptyId).ok, false);
  const withBadMember = {
    ...base,
    data: {
      ...(base.data as { kind: 'enhance' }),
      groups: [
        {
          id: 'alignment:1',
          basis: 'canonical_url',
          strength: 'exact',
          members: [{ entity: { id: '', type: '' }, provider: '' }],
        },
      ],
    },
  };
  assert.equal(validateKnowledgeResult(withBadMember).ok, false);
});

test('buildKnowledgeResult fails closed on invalid envelope without leaking payload', () => {
  const secret = 'super-secret-pii-value-12345';
  let thrown: unknown;
  try {
    buildKnowledgeResult({
      request: { tool: 'kg', action: 'enhance' },
      outcomes: [{ provider: 'diffbot', entities: [kgEntity()] }],
      data: {
        kind: 'enhance',
        entities: [{ [secret]: true }],
        claims: [],
        conflicts: [],
        partitions: [{ provider: 'diffbot', status: 'ok' }],
      } as unknown as { kind: 'enhance'; entities: never[]; claims: never[]; conflicts: never[]; partitions: never[] },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, 'malformed data must throw');
  assert.equal((thrown as { code?: string }).code, 'contract_invalid_response');
  assert.ok(!String(thrown).includes(secret), 'error must not serialize payload/PII');
});

test('KG_FIELD_PROJECTION maps basic/contact/professional/all to whitelisted predicates', async () => {
  const { KG_FIELD_PROJECTION } = await import('../src/knowledge-contract.js');
  assert.ok((KG_FIELD_PROJECTION.all as readonly string[]).includes('email'));
  assert.ok(!(KG_FIELD_PROJECTION.basic as readonly string[]).includes('email'));
  assert.ok((KG_FIELD_PROJECTION.contact as readonly string[]).includes('phone'));
  assert.ok((KG_FIELD_PROJECTION.professional as readonly string[]).includes('employer'));
});
