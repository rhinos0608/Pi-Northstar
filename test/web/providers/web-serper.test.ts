import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERPER_SEARCH_ENDPOINT, SERPER_SEARCH_RESULT_MAX, serperSearchAdapter } from '../../../src/web/providers/web-serper.js';
import type { WebProviderSearchInput } from '../../../src/web/web-search-types.js';
import { jsonResponse, mockFetch } from './web-provider-test-utils.js';

const SECRET = 'serper-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { SERPER_API_KEY: SECRET },
    nativeAi: { summaries: false, answers: false },
    ...overrides,
  };
}

test('serper configured: key present, blank and absent rejected', () => {
  assert.equal(serperSearchAdapter.id, 'serper');
  assert.equal(SERPER_SEARCH_RESULT_MAX, 20);
  assert.equal(serperSearchAdapter.configured({ SERPER_API_KEY: 'k' }), true);
  assert.equal(serperSearchAdapter.configured({ SERPER_API_KEY: '  ' }), false);
  assert.equal(serperSearchAdapter.configured({}), false);
});

test('serper unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    const out = await serperSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'serper', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('serper exact endpoint, POST, X-API-KEY header, q/num body', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await serperSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, SERPER_SEARCH_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['X-API-KEY'], SECRET);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.q, 'transformer interpretability');
    assert.equal(body.num, 5);
    assert.ok(!('tbs' in body), 'tbs absent without recency');
    assert.ok(!JSON.stringify(body).includes(SECRET), 'key must not leak into body');
  } finally {
    restore();
  }
});

test('serper recency maps to tbs, domains rewrite q with site: plus headroom', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await serperSearchAdapter.search(input({ recency: 'month', domains: ['example.com', '-evil.com'] }));
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.tbs, 'qdr:m');
    assert.equal(body.q, 'transformer interpretability site:example.com -site:evil.com');
    assert.equal(body.num, 10);
  } finally {
    restore();
  }
});

test('serper num=20 retained at depth (no silent clamp to 10)', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await serperSearchAdapter.search(input({ limit: 50 }));
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.num, 20);
  } finally {
    restore();
  }
});

test('serper maps organic, drops link-less rows, post-filters domains', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      organic: [
        { title: 'T', link: 'https://example.com/a', snippet: 'excerpt' },
        { title: 'NoLink', snippet: 'x' },
        { title: 'Evil', link: 'https://evil.com/b', snippet: 'y' },
      ],
    }),
  );
  try {
    const out = await serperSearchAdapter.search(input({ domains: ['example.com'] }));
    assert.equal(out.backend, 'serper');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.hits[0], {
      title: 'T',
      url: 'https://example.com/a',
      snippet: 'excerpt',
      backend: 'serper',
    });
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally {
    restore();
  }
});

test('serper invalid top-level shapes reject', async () => {
  for (const body of [[], null, {}, { organic: {} }]) {
    const { restore } = mockFetch(async () => jsonResponse(body));
    try {
      await assert.rejects(() => serperSearchAdapter.search(input()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
    } finally {
      restore();
    }
  }
});

test('serper 3xx rejects with one call', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
  );
  try {
    await assert.rejects(() => serperSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('serper 401/429/500 throw safe status-only errors, one call each', async () => {
  for (const status of [401, 429, 500]) {
    const { calls, restore } = mockFetch(async () => jsonResponse({ message: 'denied' }, status));
    try {
      await assert.rejects(() => serperSearchAdapter.search(input({ limit: 3 })), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `Serper search failed with HTTP ${status}`);
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  }
});

test('serper oversized JSON rejects safe', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }),
  );
  try {
    await assert.rejects(() => serperSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('serper caller abort propagates', async () => {
  const controller = new AbortController();
  controller.abort();
  const { restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    await assert.rejects(() => serperSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});

test('serper empty organic succeeds empty', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ organic: [] }));
  try {
    const out = await serperSearchAdapter.search(input());
    assert.deepEqual(out, { backend: 'serper', hits: [], generatedText: [] });
  } finally {
    restore();
  }
});
