import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiffbotFetchOptions } from '../../src/diffbot/diffbot-transport.js';
import { DiffbotError } from '../../src/diffbot/diffbot-transport.js';
import {
  analyzeTextDiffbotKg,
  enhanceDiffbotKg,
  searchDiffbotKg,
} from '../../src/diffbot/diffbot-kg.js';

const TOKEN = 'test-token-123';

function mockFetch(handler: (options: DiffbotFetchOptions) => unknown) {
  const calls: DiffbotFetchOptions[] = [];
  const fetchFn = async (options: DiffbotFetchOptions): Promise<unknown> => {
    calls.push(options);
    return handler(options);
  };
  return { calls, fetchFn };
}

function dqlEntity(overrides: Record<string, unknown> = {}) {
  return {
    score: 12.5,
    entity: {
      diffbotUri: 'https://diffbot.com/entity/abc123',
      type: 'Organization',
      name: 'Acme Corp',
      homepageUri: 'https://acme.example.com',
      ...overrides,
    },
  };
}

// ── search ──

test('search POSTs DQL body and normalizes data[].entity rows', async () => {
  const { calls, fetchFn } = mockFetch(() => ({
    hits: 2,
    facet: false,
    data: [dqlEntity(), dqlEntity({ diffbotUri: 'https://diffbot.com/entity/xyz', name: 'Beta' })],
  }));
  const result = await searchDiffbotKg(
    { query: 'type:Organization name:"Acme"', limit: 2 },
    { token: TOKEN, fetchFn },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.entities.length, 2);
  assert.equal(result.entities[0]?.id, 'https://diffbot.com/entity/abc123');
  assert.equal(result.entities[0]?.type, 'Organization');
  assert.equal(result.entities[0]?.name, 'Acme Corp');
  assert.equal(result.entities[0]?.url, 'https://acme.example.com');
  assert.equal(result.invalid, 0);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(String(call.host), 'https://kg.diffbot.com');
  assert.equal(call.path, '/kg/v3/dql');
  assert.equal(call.method, 'POST');
  const body = call.body as Record<string, unknown>;
  assert.equal(body.type, 'query');
  assert.equal(body.query, 'type:Organization name:"Acme"');
  assert.equal(body.size, 2);
  assert.equal(call.token, TOKEN);
  assert.ok(!JSON.stringify(body).includes(TOKEN), 'token must not appear in POST body');
});

test('search rejects facet/report/export/collection DQL without calling fetch', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ data: [] }));
  for (const query of [
    'type:Person facet:employer',
    'report on hiring',
    'export format=csv type:Person',
    'from collection:people type:Person',
  ]) {
    const result = await searchDiffbotKg({ query }, { token: TOKEN, fetchFn });
    assert.equal(result.entities.length, 0, query);
    assert.equal(result.error?.code, 'unsupported_option', query);
    assert.equal(result.error?.retryable, false, query);
  }
  assert.equal(calls.length, 0);
});

test('search treats facet:true upstream flag as semantic_invalid_response', async () => {
  const { fetchFn } = mockFetch(() => ({ facet: true, data: [] }));
  const result = await searchDiffbotKg({ query: 'type:Organization' }, { token: TOKEN, fetchFn });
  assert.equal(result.entities.length, 0);
  assert.equal(result.error?.code, 'semantic_invalid_response');
});

test('search maps non-array data envelope to contract_invalid_response', async () => {
  const { fetchFn } = mockFetch(() => ({ hits: 0 }));
  const result = await searchDiffbotKg({ query: 'type:Organization' }, { token: TOKEN, fetchFn });
  assert.equal(result.error?.code, 'contract_invalid_response');
});

test('search counts row-level errors as invalid while siblings survive', async () => {
  const { fetchFn } = mockFetch(() => ({
    facet: false,
    data: [dqlEntity(), { error: 'not found', errorCode: 404 }, { entity: { nope: true } }],
  }));
  const result = await searchDiffbotKg({ query: 'type:Organization' }, { token: TOKEN, fetchFn });
  assert.equal(result.entities.length, 1);
  assert.equal(result.invalid, 2);
  assert.equal(result.error, undefined);
});

test('search maps upstream DiffbotError codes without leaking the token', async () => {
  const { fetchFn } = mockFetch(() => {
    throw new DiffbotError('upstream_error', `boom ${TOKEN} fail`, { retryable: false });
  });
  const result = await searchDiffbotKg({ query: 'type:Organization' }, { token: TOKEN, fetchFn });
  assert.equal(result.entities.length, 0);
  assert.equal(result.error?.code, 'upstream_error');
  assert.ok(!String(result.error?.message).includes(TOKEN), 'token must not leak in error');
});

// ── enhance ──

test('enhance POSTs selectors as body, maps size, sends no native options', async () => {
  const { calls, fetchFn } = mockFetch(() => ({
    hits: 1,
    data: [{ entity: { diffbotUri: 'https://diffbot.com/entity/p1', type: 'Person', name: 'Ada' } }],
  }));
  const result = await enhanceDiffbotKg(
    { type: 'Person', name: 'Ada Lovelace', maxEntities: 3 },
    { token: TOKEN, fetchFn },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0]?.id, 'https://diffbot.com/entity/p1');
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(String(call.host), 'https://kg.diffbot.com');
  assert.equal(call.path, '/kg/v3/enhance');
  assert.equal(call.method, 'POST');
  const body = call.body as Record<string, unknown>;
  assert.equal(body.type, 'Person');
  assert.deepEqual(body.name, ['Ada Lovelace']);
  assert.equal(body.size, 3);
  for (const banned of ['refresh', 'threshold', 'search', 'filter', 'ip']) {
    assert.ok(!(banned in body), `native option ${banned} must not be sent`);
  }
  assert.ok(!JSON.stringify(body).includes(TOKEN), 'token must not appear in POST body');
});

test('enhance rejects missing selectors and Person-only keys on Organization', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ data: [] }));
  const missing = await enhanceDiffbotKg({ type: 'Person' }, { token: TOKEN, fetchFn });
  assert.equal(missing.error?.code, 'invalid_input');
  const personOnly = await enhanceDiffbotKg(
    { type: 'Organization', name: 'Acme', employer: 'x' },
    { token: TOKEN, fetchFn },
  );
  assert.equal(personOnly.error?.code, 'invalid_input');
  assert.equal(calls.length, 0);
});

// ── analyze_text ──

const NLP_DOC = {
  language: 'en',
  sentiment: 0.42,
  entities: [
    {
      name: 'Diffbot',
      diffbotUri: 'https://diffbot.com/entity/EX1',
      confidence: 0.99,
      allTypes: [{ name: 'organization' }],
      mentions: [{ text: 'Diffbot', beginOffset: 0, endOffset: 7, confidence: 0.99 }],
    },
    {
      name: 'Mystery',
      diffbotUri: 'https://diffbot.com/entity/EX2',
      confidence: 0.5,
      allTypes: [{ name: 'QuantumWidget' }],
      mentions: [{ text: 'nope', beginOffset: 9999, endOffset: 10005 }],
    },
  ],
  facts: [
    {
      humanReadable: 'Diffbot is headquartered in Menlo Park',
      entity: { name: 'Diffbot', diffbotUri: 'https://diffbot.com/entity/EX1' },
      property: { name: 'headquarters' },
      value: { name: 'Menlo Park' },
    },
  ],
  categories: { iabv1: [{ name: 'Technology', confidence: 0.9 }] },
};

test('analyze_text POSTs one-document array with fields from extract flags', async () => {
  const { calls, fetchFn } = mockFetch(() => [NLP_DOC]);
  const text = 'Diffbot builds knowledge graphs.';
  const result = await analyzeTextDiffbotKg(
    { text, extractEntities: true, extractFacts: true, extractSentiment: true, extractTopics: true, language: 'en' },
    { token: TOKEN, fetchFn },
  );
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(String(call.host), 'https://nl.diffbot.com');
  assert.equal(call.method, 'POST');
  assert.ok(String(call.query?.fields).includes('entities'), 'fields must include entities');
  assert.ok(String(call.query?.fields).includes('facts'), 'fields must include facts');
  assert.ok(String(call.query?.fields).includes('sentiment'), 'fields must include sentiment');
  const body = call.body as Array<Record<string, unknown>>;
  assert.equal(body.length, 1);
  assert.equal(body[0]?.content, text);
  assert.equal(body[0]?.lang, 'en');
  assert.ok(!JSON.stringify(body).includes(TOKEN), 'token must not appear in POST body');
  // Valid mention survives; out-of-range mention dropped row-level.
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0]?.offset, 0);
  assert.equal(result.mentions[0]?.length, 7);
  // Unknown ontology term namespaced, known term canonicalized.
  const types = result.entities.map((entity: { type: string }) => entity.type).sort();
  assert.ok(types.includes('Organization'), `expected Organization in ${types}`);
  assert.ok(types.includes('diffbot:QuantumWidget'), `expected namespaced term in ${types}`);
  // Facts mapped, sentiment worded, topics from categories.
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.predicate, 'headquarters');
  assert.equal(result.sentiment, 'positive');
  assert.ok(result.topics.includes('Technology'));
});

test('analyze_text rejects empty and oversize text without calling fetch', async () => {
  const { calls, fetchFn } = mockFetch(() => []);
  const empty = await analyzeTextDiffbotKg({ text: '' }, { token: TOKEN, fetchFn });
  assert.equal(empty.error?.code, 'invalid_input');
  const huge = await analyzeTextDiffbotKg({ text: 'x'.repeat(100001) }, { token: TOKEN, fetchFn });
  assert.equal(huge.error?.code, 'invalid_input');
  assert.equal(calls.length, 0);
});

test('analyze_text maps non-array envelope to contract_invalid_response', async () => {
  const { fetchFn } = mockFetch(() => ({ entities: [] }));
  const result = await analyzeTextDiffbotKg({ text: 'hello' }, { token: TOKEN, fetchFn });
  assert.equal(result.error?.code, 'contract_invalid_response');
});

// ── shared ──

test('missing token returns contract_invalid_response without calling fetch', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ data: [] }));
  const result = await searchDiffbotKg({ query: 'type:Person' }, { token: '', fetchFn });
  assert.equal(result.error?.code, 'contract_invalid_response');
  assert.equal(calls.length, 0);
});

test('enhance sends string selectors as strings, only name/url/email as arrays', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ data: [] }));
  await enhanceDiffbotKg(
    { type: 'Person', name: 'Ada', location: 'London', phone: '+15550100', description: 'engineer' },
    { token: TOKEN, fetchFn },
  );
  const body = calls[0]?.body as Record<string, unknown>;
  assert.deepEqual(body.name, ['Ada']);
  assert.equal(body.location, 'London');
  assert.equal(body.phone, '+15550100');
  assert.equal(body.description, 'engineer');
});

test('enhance maps top-level errors[] to upstream_error and row errors[] to invalid siblings', async () => {
  const { fetchFn: topFetch } = mockFetch(() => ({ data: [], errors: ['kg unavailable'] }));
  const top = await enhanceDiffbotKg({ type: 'Person', name: 'Ada' }, { token: TOKEN, fetchFn: topFetch });
  assert.equal(top.error?.code, 'upstream_error');
  const { fetchFn: rowFetch } = mockFetch(() => ({
    data: [
      { entity: { diffbotUri: 'https://diffbot.com/entity/p1', type: 'Person', name: 'Ada' } },
      { errors: ['row failed'], entity: { diffbotUri: 'https://diffbot.com/entity/p2', type: 'Person', name: 'Bo' } },
    ],
  }));
  const rows = await enhanceDiffbotKg({ type: 'Person', name: 'Ada' }, { token: TOKEN, fetchFn: rowFetch });
  assert.equal(rows.entities.length, 1);
  assert.equal(rows.invalid, 1);
});

test('enhance returns whitelisted claims, applies fields/threshold/relationships client-side', async () => {
  const { fetchFn } = mockFetch(() => ({
    data: [{
      score: 9.1,
      esscore: 1.2,
      entity: {
        diffbotUri: 'https://diffbot.com/entity/p1',
        type: 'Person',
        name: 'Ada',
        emailAddresses: [{ contactString: 'ada@example.com' }],
        employments: [{ employer: { name: 'Acme' }, title: 'Engineer' }],
      },
    }],
  }));
  const full = await enhanceDiffbotKg({ type: 'Person', name: 'Ada' }, { token: TOKEN, fetchFn });
  assert.ok((full.claims ?? []).some((c) => c.predicate === 'email' && c.provider === 'diffbot'));
  assert.ok((full.claims ?? []).some((c) => c.predicate === 'employer'));
  assert.ok((full.notes ?? []).some((n) => n.includes('match_scores')));
  const contact = await enhanceDiffbotKg({ type: 'Person', name: 'Ada', fields: 'contact' }, { token: TOKEN, fetchFn });
  assert.ok((contact.claims ?? []).length > 0);
  assert.ok((contact.claims ?? []).every((c) => c.predicate === 'email' || c.predicate === 'phone'));
  const noRel = await enhanceDiffbotKg(
    { type: 'Person', name: 'Ada', includeRelationships: false },
    { token: TOKEN, fetchFn },
  );
  assert.ok(!(noRel.claims ?? []).some((c) => c.predicate === 'employer'));
  const evidenced = await enhanceDiffbotKg(
    { type: 'Person', name: 'Ada', includeEvidence: true },
    { token: TOKEN, fetchFn },
  );
  assert.equal(evidenced.evidence?.[0]?.evidence.status, 'provided');
  const unrequested = await enhanceDiffbotKg({ type: 'Person', name: 'Ada' }, { token: TOKEN, fetchFn });
  assert.equal(unrequested.evidence?.[0]?.evidence.status, 'not_requested');
});

test('adapter honors passed spend defaults and rejects above-cap requests without clamping', async () => {
  const { calls: searchCalls, fetchFn: searchFetch } = mockFetch(() => ({ facet: false, data: [] }));
  await searchDiffbotKg({ query: 'type:Person' }, { token: TOKEN, fetchFn: searchFetch, spend: { searchDefault: 7 } });
  assert.equal((searchCalls[0]?.body as Record<string, unknown>).size, 7);
  const { fetchFn: overFetch } = mockFetch(() => ({ facet: false, data: [] }));
  const over = await searchDiffbotKg({ query: 'type:Person', limit: 9 }, { token: TOKEN, fetchFn: overFetch, spend: { searchCap: 5 } });
  assert.equal(over.error?.code, 'invalid_input');
  const { calls: enhanceCalls, fetchFn: enhanceFetch } = mockFetch(() => ({ data: [] }));
  await enhanceDiffbotKg({ type: 'Person', name: 'Ada' }, { token: TOKEN, fetchFn: enhanceFetch, spend: { enhanceDefault: 4 } });
  assert.equal((enhanceCalls[0]?.body as Record<string, unknown>).size, 4);
  const { fetchFn: nlpFetch } = mockFetch(() => []);
  const nlp = await analyzeTextDiffbotKg({ text: 'hello' }, { token: TOKEN, fetchFn: nlpFetch, spend: { nlpMaxChars: 3 } });
  assert.equal(nlp.error?.code, 'invalid_input');
});

test('search surfaces textFallback weakening as a note', async () => {
  const { fetchFn } = mockFetch(() => ({ facet: false, textFallback: true, data: [] }));
  const result = await searchDiffbotKg({ query: 'type:Person' }, { token: TOKEN, fetchFn });
  assert.ok((result.notes ?? []).some((n) => n.includes('text_fallback')));
});

test('analyze_text bounds fact and topic strings to contract limits', async () => {
  const longSubject = 's'.repeat(600);
  const longPredicate = 'p'.repeat(200);
  const longObject = 'o'.repeat(9000);
  const longTopic = 't'.repeat(200);
  const { fetchFn } = mockFetch(() => ([
    {
      facts: [
        {
          entity: { diffbotUri: longSubject },
          property: { name: longPredicate },
          value: { name: longObject },
        },
      ],
      categories: { iabv1: [{ name: longTopic }] },
    },
  ]));
  const result = await analyzeTextDiffbotKg(
    { text: 'hello world', extractFacts: true, extractTopics: true },
    { token: TOKEN, fetchFn },
  );
  assert.equal(result.facts[0]?.subjectId.length, 512);
  assert.equal(result.facts[0]?.predicate.length, 128);
  assert.equal(result.facts[0]?.object?.length, 8000);
  assert.equal(result.topics[0]?.length, 128);
});

test('enhance carries normalized identity signals 1:1 with kept entities, no raw payload', async () => {
  const { fetchFn } = mockFetch(() => ({
    data: [
      {
        entity: {
          diffbotUri: 'https://diffbot.com/entity/e1',
          type: 'Person',
          name: 'Alice A',
          emailAddresses: [{ contactString: 'Shared@Example.COM' }],
          phoneNumbers: [{ contactString: '+1-555-0100' }],
        },
      },
    ],
  }));
  const result = await enhanceDiffbotKg({ type: 'Person', name: 'Alice' }, { token: TOKEN, fetchFn });
  assert.equal(result.error, undefined);
  assert.equal(result.entities.length, 1);
  assert.equal(result.signals?.length, 1);
  assert.deepEqual(result.signals?.[0]?.emails, ['shared@example.com']);
  assert.deepEqual(result.signals?.[0]?.phones, ['+1-555-0100']);
  assert.ok(!JSON.stringify(result).includes('contactString'), 'raw provider rows must not leak');
});

test('search carries normalized identity signals 1:1 with entities', async () => {
  const { fetchFn } = mockFetch(() => ({
    facet: false,
    data: [dqlEntity({ emailAddresses: [{ contactString: 'Shared@Example.COM' }] })],
  }));
  const result = await searchDiffbotKg({ query: 'type:Organization' }, { token: TOKEN, fetchFn });
  assert.equal(result.error, undefined);
  assert.equal(result.entities.length, 1);
  assert.equal(result.signals?.length, 1);
  assert.deepEqual(result.signals?.[0]?.emails, ['shared@example.com']);
});

test('search bounds from before paid call with cursor_invalid and zero fetch', async () => {
  const { DIFFBOT_KG_MAX_FROM } = await import('../../src/diffbot/diffbot-kg.js');
  assert.equal(DIFFBOT_KG_MAX_FROM, 10000);
  for (const from of [DIFFBOT_KG_MAX_FROM + 1, 9995]) {
    const { calls, fetchFn } = mockFetch(() => ({ facet: false, data: [] }));
    const result = await searchDiffbotKg({ query: 'type:Person', limit: 10, from }, { token: TOKEN, fetchFn });
    assert.equal(result.error?.code, 'cursor_invalid', `from=${from}`);
    assert.equal(calls.length, 0, 'hostile offset must reject before any paid call');
  }
  const { calls: okCalls, fetchFn: okFetch } = mockFetch(() => ({ facet: false, data: [] }));
  const ok = await searchDiffbotKg({ query: 'type:Person', limit: 10, from: 10 }, { token: TOKEN, fetchFn: okFetch });
  assert.equal(ok.error, undefined);
  assert.equal(okCalls.length, 1);
});
