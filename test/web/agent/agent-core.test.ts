import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactProvenance, runAgentCore } from '../../../src/web/agent/agent-core.js';
import { AGENT_RUN_DEADLINE_MS, validateAgentResult } from '../../../src/web/agent/agent-contract.js';

// Evidence-only floor: bodies must clear the chunker admission floor, so
// every fixture carries digit-free filler past 100 chars (filler adds no
// value tokens, keeping verification disjointness intact where needed).
const FILLER =
  ' Additional background context about the product lineup and release notes follows here for completeness and extra length.';
const BODY = (url: string): string => `Body text about pricing tiers for ${url}. Pricing details follow.${FILLER}`;

const hits = [
  { title: 'Alpha pricing', url: 'https://example.com/alpha', snippet: 'alpha pricing tiers', backend: 'tavily', provider: 'tavily', model: 'pro' },
  { title: 'Beta pricing', url: 'https://example.com/beta', snippet: 'beta pricing plans', backend: 'exa', provider: 'exa', model: 'mini' },
];

test('core evidence-only composes cited sources with provenance redacted', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => BODY(url),
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

test('core evidence-only keeps first-seen ledger order with no lexical rerank', async () => {
  const result = await runAgentCore('zebra migration', {
    search: async () => [
      { title: 'Unrelated', url: 'https://example.com/plain', snippet: 'plain page' },
      { title: 'Zebra', url: 'https://example.com/zebra', snippet: 'zebra page' },
    ],
    fetchText: async (url: string) =>
      url.includes('zebra')
        ? `zebra migration patterns across savanna corridors, zebra herds move seasonally here today.${FILLER}`
        : `plain page with ordinary words and nothing relevant at all here today for the test.${FILLER}`,
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  const zebra = result.sources.find((source) => source.url.includes('zebra'));
  const plain = result.sources.find((source) => source.url.includes('plain'));
  assert.ok(zebra && plain);
  assert.ok(result.sources.indexOf(zebra) > result.sources.indexOf(plain), 'ledger first-seen order, no passage rerank');
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

test('evidence-only floor ships admitted excerpts as catalog-cited claims', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => BODY(url),
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(result.claims.length > 0);
  for (const claim of result.claims) {
    // No recomposed prose: each evidence-only claim cites exactly its own
    // ledger-group source.
    assert.equal(claim.sourceIds.length, 1);
    const source = result.sources.find((entry) => entry.id === claim.sourceIds[0]);
    assert.ok(source !== undefined);
  }
  assert.ok(result.claims.some((claim) => claim.text.includes('Pricing details follow')));
});

test('evidence-only floor clips overlong excerpts to the claim byte budget', async () => {
  const { AGENT_CLAIM_MAX_BYTES } = await import('../../../src/web/agent/agent-contract.js');
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => `Body text about pricing tiers for ${url}. ${'é'.repeat(AGENT_CLAIM_MAX_BYTES)}.`,
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  for (const claim of result.claims) {
    assert.ok(Buffer.byteLength(claim.text, 'utf8') <= AGENT_CLAIM_MAX_BYTES);
  }
  const unpunctuated = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async () => 'z'.repeat(AGENT_CLAIM_MAX_BYTES * 2),
  });
  assert.ok(validateAgentResult(unpunctuated).ok, JSON.stringify(validateAgentResult(unpunctuated).issues));
  for (const claim of unpunctuated.claims) {
    assert.ok(Buffer.byteLength(claim.text, 'utf8') <= AGENT_CLAIM_MAX_BYTES);
  }
});

test('fetch failure excludes the failed URL from sources and claims', async () => {
  const result = await runAgentCore('pricing tiers', {
    search: async () => [...hits],
    fetchText: async (url: string) => {
      if (url.includes('beta')) throw new Error('fetch failed');
      return BODY(url);
    },
  });
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(!result.sources.some((source) => source.url.includes('beta')), 'failed fetch never becomes a source');
  assert.ok(result.sources.some((source) => source.url.includes('alpha')));
  for (const claim of result.claims) {
    for (const id of claim.sourceIds) assert.ok(result.sources.some((source) => source.id === id));
  }
  assert.ok(result.warnings.some((warning) => /fetch round \d+ failed; passage skipped/.test(warning)));
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
    fetchText: async (url: string) => BODY(url),
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

test('gather progress detail carries count-only candidate accounting per round', async () => {
  const { questionId } = await import('../../../src/web/agent/agent-state.js');
  const QUESTION = 'Acme Pro pricing config';
  const qid = questionId(QUESTION);
  const candidate = (path: string): Record<string, unknown> => ({
    kind: 'github-code',
    route: 'github',
    owner: 'acme',
    repo: 'pro',
    path,
    ref: 'main',
    url: `https://example.com/acme/pro/blob/main/${path}`,
    title: path,
  });
  const roundCandidates = [
    [candidate('config/pricing.ts'), candidate('config/tiers.ts')],
    // Round 2 repeats the same rows: cross-round dedupe drops both.
    [candidate('config/pricing.ts'), candidate('config/tiers.ts')],
  ];
  const seen: Array<{ round: number; added: number | undefined; dropped: number | undefined }> = [];
  let evalCalls = 0;
  await runAgentCore(QUESTION, {
    search: async () => [],
    fetchText: async () => '',
    planner: async () => ({
      questions: [
        {
          question: QUESTION,
          priority: 3,
          required: true,
          intent: { kind: 'github_search', scope: 'code', query: 'Acme Pro pricing config code', repoHint: 'acme/pro' },
        },
      ],
      scopeNotes: [],
    }),
    evaluator: async () => {
      evalCalls += 1;
      if (evalCalls === 1) {
        return {
          questionUpdates: [],
          nextActions: [
            {
              questionId: qid,
              intent: { kind: 'github_search', scope: 'code', query: 'Acme Pro pricing config code', repoHint: 'acme/pro' },
            },
          ],
          shouldContinue: true,
        };
      }
      return { questionUpdates: [], nextActions: [], shouldContinue: false };
    },
    gatherExecutor: async (intents, round) => ({
      admitted: [],
      candidates: [...(roundCandidates[round - 1] ?? [])] as never[],
      warnings: [],
      searchesUsed: 1,
      fetchesUsed: 0,
      queriesSearched: ['Acme Pro pricing config code'],
      queryRejected: 0,
      webContent: [],
      perAction: intents.map(() => ({ route: 'github', degraded: false })),
    }),
    gatherProfile: 'balanced',
    budgets: { maxRounds: 3 },
    onProgress: (p) => {
      if (p.stage === 'gather') {
        seen.push({ round: p.round, added: p.detail?.candidatesAdded, dropped: p.detail?.candidatesDropped });
      }
    },
  });
  assert.equal(evalCalls, 2, 'evaluator continues to a second gather round');
  assert.equal(seen.length, 2, 'one gather boundary per round');
  assert.deepEqual([seen[0]?.added, seen[0]?.dropped], [2, 0]);
  assert.deepEqual([seen[1]?.added, seen[1]?.dropped], [0, 2]);
  for (const [index, entry] of seen.entries()) {
    assert.equal(
      (entry.added ?? -1) + (entry.dropped ?? -1),
      roundCandidates[index]!.length,
      `round ${entry.round}: added + dropped sums to the executor candidate count`,
    );
  }
});
