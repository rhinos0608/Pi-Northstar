import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactProvenance, runAgentCore } from '../../../src/web/agent/agent-core.js';
import { validateAgentResult } from '../../../src/web/agent/agent-contract.js';

const hits = [
  { title: 'Alpha pricing', url: 'https://example.com/alpha', snippet: 'alpha pricing tiers', backend: 'tavily', provider: 'tavily', model: 'pro' },
  { title: 'Beta pricing', url: 'https://example.com/beta', snippet: 'beta pricing plans', backend: 'exa', provider: 'exa', model: 'mini' },
];

test('core composes cited sources with provenance redacted', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({ text: 'Alpha offers tiers. Beta offers plans.', sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }] }),
  });
  assert.equal(result.version, 1);
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(result.sources.length > 0);
  assert.ok(result.claims.length > 0);
  const body = JSON.stringify(result);
  assert.ok(!body.includes('"provider"'), 'provider keys must not leak');
  assert.ok(!body.includes('"model"'), 'model keys must not leak');
  assert.ok(!body.includes('"backend"'), 'backend keys must not leak');
  for (const claim of result.claims) {
    assert.ok(claim.sourceIds.length > 0);
    for (const id of claim.sourceIds) assert.ok(result.sources.some((source) => source.id === id));
  }
});

test('core lexical pass orders BM25-relevant passages first', async () => {
  const result = await runAgentCore('zebra migration', {
    search: async () => [
      { title: 'Unrelated', url: 'https://example.com/plain', snippet: 'plain page' },
      { title: 'Zebra', url: 'https://example.com/zebra', snippet: 'zebra page' },
    ],
    fetchText: async (url: string) =>
      url.includes('zebra')
        ? 'zebra migration patterns across savanna corridors, zebra herds move seasonally'
        : 'plain page with ordinary words and nothing relevant at all here today',
    report: async () => { throw new Error('report down'); },
  });
  assert.ok(result.warnings.some((warning) => /local evidence only/.test(warning)));
  const zebra = result.sources.find((source) => source.url.includes('zebra'));
  const plain = result.sources.find((source) => source.url.includes('plain'));
  assert.ok(zebra && plain);
  assert.ok(result.sources.indexOf(zebra) < result.sources.indexOf(plain), 'BM25-relevant source ranks first');
});

test('redactProvenance strips key variants while legit keys survive', () => {
  const out = redactProvenance({
    title: 'T', url: 'https://example.com', text: 'body', query: 'q',
    sources: [{ id: 's-0' }], claims: ['c'],
    providers: 'x', modelName: 'y', providerId: 'z', authToken: 't',
    authorization: 'b', apiKeys: ['k'], backendName: 'n', tokens: 1,
    'x-provider': 'p', nested: { api_key: 'k', keep: true },
    list: [{ secret: 1, ok: 2 }],
  });
  assert.deepEqual(out, {
    title: 'T', url: 'https://example.com', text: 'body', query: 'q',
    sources: [{ id: 's-0' }], claims: ['c'],
    nested: { keep: true }, list: [{ ok: 2 }],
  });
});

test('redactProvenance strips provider/model/secret keys deeply', () => {
  const out = redactProvenance({ a: 1, provider: 'x', nested: { model: 'y', keep: true }, token: 's', list: [{ auth: 1, ok: 2 }] });
  assert.deepEqual(out, { a: 1, nested: { keep: true }, list: [{ ok: 2 }] });
});

test('core clips overlong claims to the byte budget', async () => {
  const { AGENT_CLAIM_MAX_BYTES } = await import('../../../src/web/agent/agent-contract.js');
  const long = 'é'.repeat(AGENT_CLAIM_MAX_BYTES);
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'Alpha offers tiers.',
      sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }],
      claims: [{ text: long, sourceIds: ['src-0'] }],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  for (const claim of result.claims) {
    assert.ok(Buffer.byteLength(claim.text, 'utf8') <= AGENT_CLAIM_MAX_BYTES);
  }
  const unpunctuated = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async () => 'z'.repeat(AGENT_CLAIM_MAX_BYTES * 2),
    report: async () => { throw new Error('report down'); },
  });
  assert.ok(validateAgentResult(unpunctuated).ok, JSON.stringify(validateAgentResult(unpunctuated).issues));
});

test('structured report claims ship verbatim; report sentences never round-robin', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'Unmapped sentence one. Unmapped sentence two.',
      sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }],
      claims: [{ text: 'Structured finding.', sourceIds: ['src-0'] }],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.deepEqual(result.claims, [{ text: 'Structured finding.', sourceIds: ['src-0'] }]);
  for (const claim of result.claims) {
    assert.ok(!claim.text.includes('Unmapped'));
  }
});

test('unverifiable structured claims drop to passage-derived claims', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'Unmapped sentence one. Unmapped sentence two.',
      sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }],
      claims: [{ text: 'Dangling claim.', sourceIds: ['nope'] }],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(result.claims.length > 0);
  for (const claim of result.claims) {
    assert.ok(!claim.text.includes('Unmapped'));
    assert.ok(!claim.text.includes('Dangling'));
    for (const id of claim.sourceIds) assert.ok(result.sources.some((source) => source.id === id));
  }
});
