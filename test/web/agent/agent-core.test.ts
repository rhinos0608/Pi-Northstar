import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactProvenance, runAgentCore } from '../../../src/web/agent/agent-core.js';
import { AGENT_RUN_DEADLINE_MS, validateAgentResult } from '../../../src/web/agent/agent-contract.js';

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

test('redactProvenance keeps author/authors but strips auth variants', () => {
  const out = redactProvenance({
    author: 'Jane', authors: ['Jane', 'Jo'],
    auth: 'x', authToken: 't', authorization: 'b', AuthHeaders: 'h',
    nested: { author: 'Nested', authToken: 'strip' },
  });
  assert.deepEqual(out, {
    author: 'Jane', authors: ['Jane', 'Jo'],
    nested: { author: 'Nested' },
  });
});

test('redactProvenance strips extended secret stems deeply', () => {
  const out = redactProvenance({
    title: 'T', url: 'https://example.com', text: 'body', query: 'q',
    sources: [{ id: 's-0' }], claims: ['c'],
    passwd: 'x', password: 'y', credentials: 'z', credential: 'w',
    bearer: 'b', bearerToken: 'bt', private_key: 'pk', 'private-key': 'pk2',
    nested: { password: 'strip', author: 'Keep', keep: true },
    list: [{ passwd: 1, ok: 2 }],
  });
  assert.deepEqual(out, {
    title: 'T', url: 'https://example.com', text: 'body', query: 'q',
    sources: [{ id: 's-0' }], claims: ['c'],
    nested: { author: 'Keep', keep: true },
    list: [{ ok: 2 }],
  });
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

test('claims citing never-fetched report sources drop with warning', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => {
      if (url.includes('gamma')) throw new Error('fetch failed');
      return `Body text about pricing tiers for ${url}. Pricing details follow.`;
    },
    report: async () => ({
      text: 'Alpha offers tiers. Gamma offers plans.',
      sources: [
        { url: 'https://example.com/alpha', title: 'Alpha' },
        { url: 'https://example.com/gamma', title: 'Gamma' },
      ],
      claims: [
        { text: 'Fetched claim.', sourceIds: ['src-0'] },
        { text: 'Never-fetched claim.', sourceIds: ['src-1'] },
      ],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  // src-0 (fetched) survives; src-1 (never fetched) drops with warning.
  assert.deepEqual(result.claims, [{ text: 'Fetched claim.', sourceIds: ['src-0'] }]);
  assert.ok(
    result.warnings.includes('claim dropped; source not fetched locally: https://example.com/gamma'),
    `missing drop warning; got ${JSON.stringify(result.warnings)}`,
  );
  assert.equal(result.warnings.filter((w) => w.startsWith('claim dropped; source not fetched locally:')).length, 1, 'identical drop warnings dedupe');
});

test('claims citing fetched sources keep the fetched-source warning absent', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'Alpha offers tiers.',
      sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }],
      claims: [{ text: 'Fetched claim.', sourceIds: ['src-0'] }],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.deepEqual(result.claims, [{ text: 'Fetched claim.', sourceIds: ['src-0'] }]);
  assert.ok(!result.warnings.some((w) => w.includes('not fetched locally')), 'no drop warnings when all cited sources fetched');
});

test('mixed fetched/unfetched multi-source claim drops the whole claim with warning', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'Alpha offers tiers.',
      sources: [
        { url: 'https://example.com/alpha', title: 'Alpha' },
        { url: 'https://example.com/gamma', title: 'Gamma' },
      ],
      claims: [{ text: 'Mixed claim spanning both.', sourceIds: ['src-0', 'src-1'] }],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  for (const claim of result.claims) {
    assert.ok(!claim.sourceIds.includes('src-1'), 'no surviving claim cites the never-fetched source');
    assert.ok(!claim.text.includes('Mixed claim spanning both.'));
  }
  assert.ok(result.warnings.some((w) => w.startsWith('claim dropped; source not fetched locally:')));
});

test('degrade path clips overlong reportText and warnings into a valid result', async () => {
  const { AGENT_REPORT_MAX_BYTES, AGENT_WARNING_MAX_BYTES } = await import('../../../src/web/agent/agent-contract.js');
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'x'.repeat(AGENT_REPORT_MAX_BYTES + 1000),
      sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }],
      warnings: ['w'.repeat(AGENT_WARNING_MAX_BYTES + 500)],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(Buffer.byteLength(result.reportText, 'utf8') <= AGENT_REPORT_MAX_BYTES, 'degraded reportText clipped');
  for (const warning of result.warnings) {
    assert.ok(Buffer.byteLength(warning, 'utf8') <= AGENT_WARNING_MAX_BYTES, 'degraded warnings clipped');
  }
});

test('non-string provider report text degrades to empty text without throwing', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({ text: 42, sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }] }) as unknown as { text: string; sources: Array<{ url: string; title: string }> },
  });
  assert.equal(result.reportText, '');
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
});

test('provider-controlled arrays cap at module bounds with warnings', async () => {
  const { MAX_REPORT_WARNINGS, MAX_STRUCTURED_CLAIMS } = await import('../../../src/web/agent/agent-core.js');
  const manySources = [
    { url: 'https://example.com/alpha', title: 'Alpha' },
    ...Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/p${i}`, title: `P${i}` })),
  ];
  const manyWarnings = Array.from({ length: 100 }, (_, i) => `provider warning ${i}`);
  const manyClaims = Array.from({ length: 200 }, (_, i) => ({ text: `Structured claim number ${i}.`, sourceIds: ['src-0'] }));
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({ text: 'Alpha offers tiers.', sources: manySources, warnings: manyWarnings, claims: manyClaims }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(result.warnings.includes('report source cap reached'), `missing source cap warning; got ${JSON.stringify(result.warnings)}`);
  assert.ok(result.warnings.includes('report warning cap reached'), `missing warning cap warning; got ${JSON.stringify(result.warnings)}`);
  assert.equal(result.warnings.filter((w) => w.startsWith('provider warning')).length, MAX_REPORT_WARNINGS);
  // src-0 is the fetched alpha page, so every sliced candidate verifies;
  // the pre-iteration slice (not the composition ceiling) sets the count.
  assert.equal(result.claims.length, MAX_STRUCTURED_CLAIMS);
  assert.ok(result.sources.length <= 20);
});

test('all-dropped structured claims terminate with passage fallback', async () => {
  const drops = Array.from({ length: 200 }, (_, i) => ({ text: `Dangling claim ${i}.`, sourceIds: ['nope'] }));
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'Alpha offers tiers.',
      sources: [{ url: 'https://example.com/alpha', title: 'Alpha' }],
      claims: drops,
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(result.claims.length > 0, 'passage-derived fallback claims ship');
  for (const claim of result.claims) assert.ok(!claim.text.includes('Dangling'));
});

test('drop warning strips zero-width, bidi, C1, and OSC hyperlink sequences', async () => {
  const evil = 'https://example.com/gamma\u200b\u200d\u202e\x85\x1b]8;;https://evil.example\x07click\x1b\\tail';
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => {
      if (url.includes('gamma')) throw new Error('fetch failed');
      return `Body text about pricing tiers for ${url}. Pricing details follow.`;
    },
    report: async () => ({
      text: 'Alpha offers tiers.',
      sources: [
        { url: 'https://example.com/alpha', title: 'Alpha' },
        { url: evil, title: 'Gamma' },
      ],
      claims: [{ text: 'Attacker-cited claim.', sourceIds: ['src-1'] }],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  const warning = result.warnings.find((w) => w.startsWith('claim dropped; source not fetched locally:'));
  assert.ok(warning, `missing drop warning; got ${JSON.stringify(result.warnings)}`);
  assert.ok(!warning.includes('\x1b'), 'no ESC byte survives');
  assert.ok(!warning.includes('\x07'), 'no BEL byte survives');
  assert.ok(!/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF\x80-\x9F]/.test(warning), 'no zero-width/bidi/BOM/C1 chars survive');
  assert.ok(!warning.includes('evil.example'), 'OSC hyperlink target stripped');
});

test('drop warning sanitizes control chars and ANSI escapes in attacker URLs', async () => {
  const evil = 'https://example.com/gamma\nInjected:\x1b[31mred\x07evil';
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({
      text: 'Alpha offers tiers.',
      sources: [
        { url: 'https://example.com/alpha', title: 'Alpha' },
        { url: evil, title: 'Gamma' },
      ],
      claims: [{ text: 'Attacker-cited claim.', sourceIds: ['src-1'] }],
    }),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  const warning = result.warnings.find((w) => w.startsWith('claim dropped; source not fetched locally:'));
  assert.ok(warning, `missing drop warning; got ${JSON.stringify(result.warnings)}`);
  assert.ok(!/[\x00-\x1F\x7F]/.test(warning), 'no control chars or newlines survive');
  assert.ok(!warning.includes('\x1b'), 'no ANSI escapes survive');
});

test('adaptive loop defaults deadline from AGENT_RUN_DEADLINE_MS; explicit wins', async () => {
  const start = 1_000_000;
  // Mutable clock: entry reads start (default = start + run deadline), the
  // first search advances past it — the derived default must fire mid-loop.
  let at = start;
  const ticking = {
    search: async () => {
      at = start + AGENT_RUN_DEADLINE_MS + 1;
      return [...hits];
    },
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. Pricing details follow.`,
    report: async () => ({ text: 'Alpha offers tiers.', sources: [] as Array<{ url: string; title: string }> }),
    budgets: {},
    now: () => at,
  };
  await assert.rejects(
    runAgentCore('pricing tiers', { ...ticking }),
    { message: 'agent job deadline exceeded' },
  );
  // Explicit deadline past the default wins: same ticking clock proceeds.
  at = start;
  const result = await runAgentCore('pricing tiers', {
    ...ticking,
    deadlineMs: start + AGENT_RUN_DEADLINE_MS + 60_000,
  });
  assert.equal(result.query, 'pricing tiers');
});
