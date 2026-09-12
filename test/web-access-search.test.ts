import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runWebAccessBatchSearch,
  resolveWebAccessBackends,
  WEB_ACCESS_RRF_K,
  type WebAccessSearchAdapter,
} from '../src/web-access-search.js';

function stub(id: 'tavily' | 'exa' | 'brave' | 'searxng', opts: {
  configured?: boolean;
  hits?: Array<{ title: string; url: string; snippet: string; publishedDate?: string }>;
  fail?: string;
  seen?: Array<{ query: string; includeContent: boolean | undefined; domains: string[] | undefined }>;
  delayMs?: number;
  active?: { current: number; max: number };
} = {}): WebAccessSearchAdapter {
  return {
    id,
    isConfigured: () => opts.configured ?? true,
    search: async (req) => {
      opts.seen?.push({ query: req.query, includeContent: req.includeContent, domains: req.domainFilter ? [...req.domainFilter] : undefined });
      if (opts.active) {
        opts.active.current++;
        opts.active.max = Math.max(opts.active.max, opts.active.current);
      }
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.fail) {
          throw { provider: id, kind: 'timeout', message: opts.fail, retryable: true };
        }
        return { provider: id, results: (opts.hits ?? [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]).map((h) => ({ ...h })) };
      } finally {
        if (opts.active) opts.active.current--;
      }
    },
  };
}

test('absent env uses first 3 configured; explicit runs all runnable', () => {
  const adapters = [stub('tavily'), stub('exa'), stub('brave'), stub('searxng')];
  const top = resolveWebAccessBackends({}, adapters);
  assert.equal(top.explicit, false);
  assert.deepEqual(top.selected, ['tavily', 'exa', 'brave']);
  const explicit = resolveWebAccessBackends({ PI_SEARCH_WEB_BACKENDS: 'searxng,exa' }, adapters);
  assert.equal(explicit.explicit, true);
  assert.deepEqual(explicit.selected, ['searxng', 'exa']);
  assert.deepEqual(explicit.runnable.map((a) => a.id), ['searxng', 'exa']);
  assert.throws(() => resolveWebAccessBackends({ PI_SEARCH_WEB_BACKENDS: 'nope' }, adapters), /unknown backend/);
  assert.throws(() => resolveWebAccessBackends({ PI_SEARCH_WEB_BACKENDS: 'exa,exa' }, adapters), /duplicate/);
});

test('batch preserves input order with concurrency 3', async () => {
  const active = { current: 0, max: 0 };
  const adapters = [stub('tavily', { delayMs: 15, active })];
  const out = await runWebAccessBatchSearch(
    { queries: ['q0', 'q1', 'q2', 'q3', 'q4'] },
    { adapters, env: {} },
  );
  assert.deepEqual(out.results.map((r) => r.query), ['q0', 'q1', 'q2', 'q3', 'q4']);
  assert.deepEqual(out.results.map((r) => r.queryIndex), [0, 1, 2, 3, 4]);
  assert.ok(active.max <= 3, `max concurrency ${active.max} exceeds 3`);
  assert.equal(WEB_ACCESS_RRF_K, 60);
});

test('recency/yearFrom intersect via injected clock; undated retained', async () => {
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  const fresh = new Date(now - 1000).toISOString();
  const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const adapters = [stub('tavily', {
    hits: [
      { title: 'Fresh', url: 'https://example.com/fresh', snippet: 's', publishedDate: fresh },
      { title: 'Stale', url: 'https://example.com/stale', snippet: 's', publishedDate: stale },
      { title: 'Undated', url: 'https://example.com/nodate', snippet: 's' },
    ],
  })];
  const out = await runWebAccessBatchSearch(
    { query: 'q', recency: 'day', yearFrom: 2020 },
    { adapters, env: {}, now: () => now },
  );
  const urls = out.results[0]?.hits.map((h) => h.url) ?? [];
  assert.ok(urls.includes('https://example.com/fresh'));
  assert.ok(urls.includes('https://example.com/nodate'));
  assert.ok(!urls.includes('https://example.com/stale'));
});

test('domains post-filter keeps exact + subdomain only', async () => {
  const adapters = [stub('tavily', {
    hits: [
      { title: 'A', url: 'https://example.com/a', snippet: 's' },
      { title: 'B', url: 'https://sub.example.com/b', snippet: 's' },
      { title: 'C', url: 'https://other.test/c', snippet: 's' },
    ],
  })];
  const out = await runWebAccessBatchSearch(
    { query: 'q', domains: ['example.com'] },
    { adapters, env: {} },
  );
  const urls = out.results[0]?.hits.map((h) => h.url) ?? [];
  assert.ok(urls.includes('https://example.com/a'));
  assert.ok(urls.includes('https://sub.example.com/b'));
  assert.ok(!urls.includes('https://other.test/c'));
});

test('dedupes normalized URLs via RRF and surfaces partial failures with provenance', async () => {
  const adapters = [
    stub('tavily', { hits: [{ title: 'A', url: 'https://example.com/a?utm_source=x', snippet: 's' }] }),
    stub('exa', { hits: [{ title: 'A2', url: 'https://example.com/a', snippet: 's2' }] }),
    stub('brave', { fail: 'slow backend' }),
  ];
  const out = await runWebAccessBatchSearch(
    { query: 'q' },
    { adapters, env: { PI_SEARCH_WEB_BACKENDS: 'tavily,exa,brave' } },
  );
  const r = out.results[0]!;
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.providers, ['tavily', 'exa']);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0]?.provider, 'brave');
});

test('no provider input; cursor only single query; includeContent passthrough', async () => {
  const seen: Array<{ query: string; includeContent: boolean | undefined; domains: string[] | undefined }> = [];
  const adapters = [stub('tavily', { seen })];
  await assert.rejects(() => runWebAccessBatchSearch({ query: 'q', provider: 'tavily' } as never, { adapters, env: {} }), /provider/);
  await assert.rejects(() => runWebAccessBatchSearch({ queries: ['a', 'b'], cursor: 'c' }, { adapters, env: {} }), /cursor/);
  const out = await runWebAccessBatchSearch({ query: 'q', includeContent: true }, { adapters, env: {} });
  assert.equal(seen[0]?.includeContent, true);
  assert.equal(out.request.includeContent, true);
  const off = await runWebAccessBatchSearch({ query: 'q' }, { adapters, env: {} });
  assert.equal(off.request.includeContent, false);
  assert.equal(off.results[0]?.inlineContent, undefined);
});
