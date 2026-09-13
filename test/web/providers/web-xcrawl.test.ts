import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XCRAWL_SERP_ENDPOINT, XCRAWL_SEARCH_RESULT_MAX, xcrawlSearchAdapter } from '../../../src/web/providers/web-xcrawl.js';
import type { WebProviderSearchInput } from '../../../src/web/web-search-types.js';
import { jsonResponse, mockFetch } from './web-provider-test-utils.js';

const SECRET = 'xcrawl-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { XCRAWL_API_KEY: SECRET },
    nativeAi: { summaries: false, answers: false },
    ...overrides,
  };
}

function okBody(rows: unknown[] = [
  { title: 'T', link: 'https://example.com/a', snippet: 'xcrawl excerpt' },
]): unknown {
  return { organic_results: rows };
}

test('xcrawl configured: key present, blank and absent rejected', () => {
  assert.equal(xcrawlSearchAdapter.id, 'xcrawl');
  assert.equal(XCRAWL_SEARCH_RESULT_MAX, 20);
  assert.equal(xcrawlSearchAdapter.configured({ XCRAWL_API_KEY: 'k' }), true);
  assert.equal(xcrawlSearchAdapter.configured({ XCRAWL_API_KEY: '  ' }), false);
  assert.equal(xcrawlSearchAdapter.configured({}), false);
});

test('xcrawl unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const out = await xcrawlSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'xcrawl', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('xcrawl exact endpoint, method, headers, engine-only body', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await xcrawlSearchAdapter.search(input({ recency: 'week', domains: ['example.com'] }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, XCRAWL_SERP_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.redirect, 'manual');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    // No filter params: engine + q only, even when recency/domains are set.
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      engine: 'google_search',
      q: 'transformer interpretability',
    });
  } finally {
    restore();
  }
});

test('xcrawl maps organic_results, slices to limit', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    title: `T${i}`,
    link: `https://example.com/${i}`,
    snippet: `s${i}`,
  }));
  const { restore } = mockFetch(async () => jsonResponse(okBody(rows)));
  try {
    const out = await xcrawlSearchAdapter.search(input({ limit: 5 }));
    assert.equal(out.backend, 'xcrawl');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 5);
    assert.deepEqual(out.hits[0], {
      title: 'T0',
      url: 'https://example.com/0',
      snippet: 's0',
      backend: 'xcrawl',
    });
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally {
    restore();
  }
});

test('xcrawl skips rows without a usable link, keeps valid siblings', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([
    { title: 'T', link: 'https://example.com/a', snippet: 'ok' },
    { title: 'Bad', snippet: 'missing link' },
    { title: 'BadScheme', link: 'ftp://example.com/f', snippet: 'x' },
  ])));
  try {
    const out = await xcrawlSearchAdapter.search(input());
    assert.equal(out.backend, 'xcrawl');
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/a');
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally {
    restore();
  }
});

test('xcrawl missing organic_results rejects', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await assert.rejects(() => xcrawlSearchAdapter.search(input()), /invalid response/);
  } finally {
    restore();
  }
});

test('xcrawl 3xx rejects', async () => {
  const { calls, restore } = mockFetch(async () => new Response(null, { status: 302 }));
  try {
    await assert.rejects(() => xcrawlSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

for (const status of [401, 429, 500]) {
  test(`xcrawl HTTP ${status}: one call, safe status-only error`, async () => {
    const { calls, restore } = mockFetch(async () => jsonResponse({ error: 'x' }, status));
    try {
      await assert.rejects(() => xcrawlSearchAdapter.search(input()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(String(status)));
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });
}

test('xcrawl oversized JSON rejects', async () => {
  const { restore } = mockFetch(async () =>
    new Response(JSON.stringify(okBody()), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2_000_000) },
    }));
  try {
    await assert.rejects(() => xcrawlSearchAdapter.search(input()), /too large|exceeded size/i);
  } finally {
    restore();
  }
});

test('xcrawl caller abort propagates', async () => {
  const { restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => xcrawlSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
