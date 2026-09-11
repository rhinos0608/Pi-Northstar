import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeWebKnowledge,
  isKnowledgeEnrichmentEnabled,
  isPersonalProfileUrl,
  isSuspectedSensitiveExcerpt,
  type WebKnowledgeBindings,
} from '../src/web-knowledge-composition.js';

function enabledEnv(): Record<string, string | undefined> {
  return { PI_SEARCH_KG_ENRICHMENT: '1' };
}

function bindingsStub(): WebKnowledgeBindings & { calls: { analyze: unknown[]; enhance: unknown[] } } {
  const calls: { analyze: unknown[]; enhance: unknown[] } = { analyze: [], enhance: [] };
  return {
    calls,
    analyzeText: async (input) => {
      calls.analyze.push(input);
      return { entities: [], mentions: [], facts: [], topics: [] };
    },
    enhance: async (input) => {
      calls.enhance.push(input);
      return { entities: [], claims: [] };
    },
  };
}

function hit(url: string, snippet: string): { url: string; title: string; snippet: string } {
  return { url, title: `t ${url}`, snippet };
}

test('gate closed makes zero calls: unset env, disabled value, no flags', async () => {
  const stub = bindingsStub();
  assert.equal(await composeWebKnowledge({ hits: [hit('https://example.com/a', 'hello')], env: {}, bindings: stub }), null);
  assert.equal(
    await composeWebKnowledge({
      hits: [hit('https://example.com/a', 'hello')],
      knowledge: { entities: true },
      env: { PI_SEARCH_KG_ENRICHMENT: '0' },
      bindings: stub,
    }),
    null,
  );
  assert.equal(
    await composeWebKnowledge({ hits: [hit('https://example.com/a', 'hello')], knowledge: {}, env: enabledEnv(), bindings: stub }),
    null,
  );
  assert.equal(
    await composeWebKnowledge({ hits: [hit('https://example.com/a', 'hello')], env: enabledEnv(), bindings: stub }),
    null,
  );
  assert.deepEqual(stub.calls, { analyze: [], enhance: [] });
});

test('invalid env value fails closed with zero calls', async () => {
  const stub = bindingsStub();
  assert.equal(isKnowledgeEnrichmentEnabled({ PI_SEARCH_KG_ENRICHMENT: 'yes' }), false);
  assert.equal(
    await composeWebKnowledge({
      hits: [hit('https://example.com/a', 'hello')],
      knowledge: { entities: true },
      env: { PI_SEARCH_KG_ENRICHMENT: 'yes' },
      bindings: stub,
    }),
    null,
  );
  assert.deepEqual(stub.calls, { analyze: [], enhance: [] });
});

test('analyzes at most first three nonempty original snippets, bounded excerpt', async () => {
  const stub = bindingsStub();
  const long = `plain text ${'x'.repeat(20_000)}`;
  const result = await composeWebKnowledge({
    hits: [hit('https://example.com/1', 'one'), hit('https://example.com/2', '   '), hit('https://example.com/3', long), hit('https://example.com/4', 'four'), hit('https://example.com/5', 'five')],
    knowledge: { entities: true },
    env: enabledEnv(),
    bindings: stub,
  });
  assert.equal(stub.calls.analyze.length, 3);
  const texts = stub.calls.analyze.map((c) => (c as { text: string }).text);
  assert.deepEqual(texts, ['one', long.slice(0, 8_000), 'four']);
  assert.ok(result !== null && result.skipped.some((s) => s.url === 'https://example.com/2' && s.reason === 'empty_excerpt'));
});

test('generated text is never submitted: analyze input carries only excerpt', async () => {
  const stub = bindingsStub();
  await composeWebKnowledge({
    hits: [hit('https://example.com/a', 'original snippet')],
    knowledge: { entities: true, facts: true },
    env: enabledEnv(),
    bindings: stub,
  });
  assert.equal(stub.calls.analyze.length, 1);
  const input = stub.calls.analyze[0] as Record<string, unknown>;
  assert.equal(input.text, 'original snippet');
  assert.deepEqual(Object.keys(input).sort(), ['extractEntities', 'extractFacts', 'extractSentiment', 'extractTopics', 'text']);
});

test('suspected sensitive excerpts skipped without echo', async () => {
  const stub = bindingsStub();
  const emailHit = hit('https://example.com/contact', 'reach Ada at ada@example.com today');
  const phoneHit = hit('https://example.com/call', 'call us on +1 415 555 0132 now please');
  const peopleHit = hit('https://example.com/list', 'row category: "people" with names');
  const profileHit = hit('https://www.linkedin.com/in/ada-lovelace', 'engineer bio here');
  assert.equal(isSuspectedSensitiveExcerpt(emailHit.snippet), true);
  assert.equal(isSuspectedSensitiveExcerpt(phoneHit.snippet), true);
  assert.equal(isSuspectedSensitiveExcerpt(peopleHit.snippet), true);
  assert.equal(isPersonalProfileUrl(profileHit.url), true);
  const result = await composeWebKnowledge({
    hits: [emailHit, phoneHit, peopleHit, profileHit],
    knowledge: { entities: true },
    env: enabledEnv(),
    bindings: stub,
  });
  assert.deepEqual(stub.calls.analyze, []);
  assert.ok(result !== null);
  assert.equal(result.skipped.length, 4);
  assert.ok(result.skipped.every((s) => s.reason === 'suspected_sensitive_or_personal'));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('ada@example.com'));
  assert.ok(!serialized.includes('415 555 0132'));
  assert.ok(!serialized.includes('reach Ada'));
});

test('enhance: max three, Person/Organization only, name plus validated homepage, no contact selectors', async () => {
  const stub: WebKnowledgeBindings & { calls: { analyze: unknown[]; enhance: unknown[] } } = {
    calls: { analyze: [], enhance: [] },
    analyzeText: async (input) => {
      (stub.calls.analyze as unknown[]).push(input);
      return {
        entities: [
          { entityVersion: 1 as const, id: 'e1', type: 'Person', name: 'Ada', url: 'https://ada.example.com' },
          { entityVersion: 1 as const, id: 'e2', type: 'Organization', name: 'Acme', url: 'https://acme.example.com/about' },
          { entityVersion: 1 as const, id: 'e3', type: 'Person', name: 'Bob', url: 'http://localhost:3000/me' },
          { entityVersion: 1 as const, id: 'e4', type: 'Article', name: 'News' },
          { entityVersion: 1 as const, id: 'e5', type: 'Person', name: 'Cat' },
        ],
        mentions: [],
        facts: [],
        topics: [],
      };
    },
    enhance: async (input) => {
      (stub.calls.enhance as unknown[]).push(input);
      return {
        entities: [{ entityVersion: 1 as const, id: `enh:${JSON.stringify(input)}`, type: 'Person', name: 'X', url: 'https://x.example.com', confidence: 0.9 }],
        claims: [
          { subjectId: 's', predicate: 'name', object: 'X' },
          { subjectId: 's', predicate: 'email', object: 'x@example.com' },
          { subjectId: 's', predicate: 'phone', object: '+1 415 555 0000' },
        ],
      };
    },
  };
  const result = await composeWebKnowledge({
    hits: [hit('https://example.com/a', 'plain public text')],
    knowledge: { enhance: true },
    env: enabledEnv(),
    bindings: stub,
  });
  assert.equal(stub.calls.enhance.length, 3);
  for (const call of stub.calls.enhance as Array<{ selectors: Record<string, string> }>) {
    assert.ok(call.selectors.name !== undefined);
    assert.ok(!('email' in call.selectors) && !('phone' in call.selectors));
    assert.deepEqual(Object.keys(call.selectors).sort(), call.selectors.url !== undefined ? ['name', 'url'] : ['name']);
    if (call.selectors.name === 'Bob') assert.ok(call.selectors.url === undefined, 'private homepage must be dropped');
  }
  assert.ok(result !== null);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('x@example.com'));
  assert.ok(!serialized.includes('415 555 0000'));
  for (const entity of result.entities.filter((e) => e.id.startsWith('enh:'))) {
    assert.deepEqual(Object.keys(entity).sort(), ['entityVersion', 'id', 'type', ...(entity.name !== undefined ? ['name'] : []), ...(entity.url !== undefined ? ['url'] : [])].sort());
  }
});

test('partial failure preserves search data with provenance and unavailable salience', async () => {
  const stub: WebKnowledgeBindings = {
    analyzeText: async (input) => {
      if ((input.text as string).includes('boom')) throw new Error('upstream down');
      return {
        entities: [{ entityVersion: 1 as const, id: 'e1', type: 'Organization', name: 'Acme' }],
        mentions: [],
        facts: [{ subjectId: 'e1', predicate: 'name', object: 'Acme' }],
        topics: ['tech'],
        sentiment: 'positive',
      };
    },
    enhance: async () => ({ entities: [], claims: [] }),
  };
  const result = await composeWebKnowledge({
    hits: [hit('https://example.com/ok', 'good public text'), hit('https://example.com/bad', 'boom public text')],
    knowledge: { entities: true, facts: true, topics: true, sentiment: true },
    env: enabledEnv(),
    bindings: stub,
  });
  assert.ok(result !== null);
  assert.equal(result.status, 'partial');
  assert.equal(result.entities.length, 1);
  assert.equal(result.facts.length, 1);
  assert.equal(result.topics.length, 1);
  assert.equal(result.sentiment, 'positive');
  assert.equal(result.partitions.length, 2);
  assert.ok(result.partitions.some((p) => p.provider === 'diffbot' && p.status === 'error'));
  assert.deepEqual(result.salience, { status: 'unavailable', reason: 'provider_unsupported' });
});

test('sentinel secrets never appear in output', async () => {
  const token = 'SENTINEL_DIFFBOT_TOKEN_xyz';
  const stub: WebKnowledgeBindings = {
    analyzeText: async () => ({
      entities: [{ entityVersion: 1 as const, id: 'e1', type: 'Organization', name: 'Acme' }],
      mentions: [],
      facts: [],
      topics: [],
    }),
    enhance: async () => ({ entities: [], claims: [] }),
  };
  const result = await composeWebKnowledge({
    hits: [hit('https://example.com/a', 'plain public text')],
    knowledge: { entities: true },
    env: { ...enabledEnv(), DIFFBOT_TOKEN: token },
    bindings: stub,
  });
  assert.ok(result !== null);
  assert.ok(!JSON.stringify(result).includes(token));
});
