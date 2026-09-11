import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerSignal, resolveWebProviderPolicy } from '../src/web-provider-policy.js';
import type { WebSearchAdapter, WebSearchProviderId } from '../src/web-search-types.js';

function stubAdapter(
  id: WebSearchProviderId,
  configuredIds: ReadonlySet<string>,
  calls: string[],
): WebSearchAdapter {
  return {
    id,
    configured: (env) => configuredIds.has(id) && env !== null,
    search: async () => {
      calls.push(id);
      return { backend: id, hits: [], generatedText: [] };
    },
  };
}

const ALL_IDS: WebSearchProviderId[] = [
  'tavily',
  'exa',
  'brave',
  'diffbot',
  'firecrawl',
  'jina',
  'searxng',
  'ollama-search',
  'duckduckgo',
  'codex',
];

function adaptersFor(configured: readonly string[], calls: string[]): WebSearchAdapter[] {
  const set = new Set(configured);
  return ALL_IDS.map((id) => stubAdapter(id, set, calls));
}

test('absent allowlist selects first three configured in preference order', () => {
  const calls: string[] = [];
  const policy = resolveWebProviderPolicy({}, adaptersFor(['brave', 'tavily', 'exa', 'diffbot'], calls));
  assert.equal(policy.explicit, false);
  assert.deepEqual(policy.selected, ['tavily', 'exa', 'brave']);
  assert.deepEqual(policy.runnable.map((a) => a.id), ['tavily', 'exa', 'brave']);
  assert.deepEqual(policy.unavailable, []);
  assert.equal(policy.timeoutMs, 12_000);
  assert.deepEqual(calls, []);
});

test('blank allowlist behaves like absent and excludes codex automatically', () => {
  const calls: string[] = [];
  const policy = resolveWebProviderPolicy(
    { PI_SEARCH_WEB_BACKENDS: '   ' },
    adaptersFor(['codex', 'tavily', 'exa', 'brave'], calls),
  );
  assert.equal(policy.explicit, false);
  assert.deepEqual(policy.selected, ['tavily', 'exa', 'brave']);
  assert.ok(!policy.selected.includes('codex'));
});

test('automatic mode takes fewer than three when fewer configured, no replenishment', () => {
  const calls: string[] = [];
  const policy = resolveWebProviderPolicy({}, adaptersFor(['jina'], calls));
  assert.deepEqual(policy.selected, ['jina']);
  assert.deepEqual(policy.runnable.map((a) => a.id), ['jina']);
});

test('explicit order preserved; unconfigured recorded as unavailable, never added', () => {
  const calls: string[] = [];
  const policy = resolveWebProviderPolicy(
    { PI_SEARCH_WEB_BACKENDS: 'jina,codex,exa' },
    adaptersFor(['exa', 'jina'], calls),
  );
  assert.equal(policy.explicit, true);
  assert.deepEqual(policy.selected, ['jina', 'codex', 'exa']);
  assert.deepEqual(policy.runnable.map((a) => a.id), ['jina', 'exa']);
  assert.deepEqual(policy.unavailable, ['codex']);
  assert.deepEqual(calls, []);
});

test('explicit list allows all eight runnable concurrently', () => {
  const calls: string[] = [];
  const list = 'tavily,exa,brave,diffbot,firecrawl,jina,searxng,ollama-search';
  const policy = resolveWebProviderPolicy({ PI_SEARCH_WEB_BACKENDS: list }, adaptersFor(list.split(','), calls));
  assert.equal(policy.runnable.length, 8);
  assert.deepEqual(policy.unavailable, []);
});

test('duplicates reject before adapter calls', () => {
  const calls: string[] = [];
  assert.throws(() => resolveWebProviderPolicy({ PI_SEARCH_WEB_BACKENDS: 'exa,tavily,exa' }, adaptersFor(['exa', 'tavily'], calls)), /duplicate/);
  assert.deepEqual(calls, []);
});

test('unknown ids reject before adapter calls', () => {
  const calls: string[] = [];
  assert.throws(() => resolveWebProviderPolicy({ PI_SEARCH_WEB_BACKENDS: 'exa,nope' }, adaptersFor(['exa'], calls)), /unknown/);
  assert.deepEqual(calls, []);
});

test('ninth id rejects before adapter calls', () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      resolveWebProviderPolicy(
        { PI_SEARCH_WEB_BACKENDS: 'tavily,exa,brave,diffbot,firecrawl,jina,searxng,ollama-search,duckduckgo' },
        adaptersFor(ALL_IDS.map(String), calls),
      ),
    /at most 8/,
  );
  assert.deepEqual(calls, []);
});

test('invalid timeout rejects before adapter calls', () => {
  const calls: string[] = [];
  for (const bad of ['0', '999', '30001', 'fast', '12.5']) {
    assert.throws(
      () => resolveWebProviderPolicy({ PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS: bad }, adaptersFor(['exa'], calls)),
      /PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS/,
    );
  }
  assert.deepEqual(calls, []);
});

test('timeout bounds accepted at edges', () => {
  const calls: string[] = [];
  assert.equal(
    resolveWebProviderPolicy({ PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS: '1000' }, adaptersFor(['exa'], calls)).timeoutMs,
    1000,
  );
  assert.equal(
    resolveWebProviderPolicy({ PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS: '30000' }, adaptersFor(['exa'], calls)).timeoutMs,
    30000,
  );
});

test('providerSignal aborts on caller abort', async () => {
  const caller = new AbortController();
  const signal = providerSignal(caller.signal, 10_000);
  assert.equal(signal.aborted, false);
  caller.abort(new Error('caller stop'));
  assert.equal(signal.aborted, true);
});

test('providerSignal aborts on timeout', async () => {
  const signal = providerSignal(undefined, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(signal.aborted, true);
});

test('providerSignal propagates already-aborted caller', () => {
  const caller = new AbortController();
  caller.abort(new Error('already'));
  const signal = providerSignal(caller.signal, 10_000);
  assert.equal(signal.aborted, true);
});
