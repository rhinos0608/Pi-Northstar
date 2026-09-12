import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERPAPI_SEARCH_ENDPOINT, SERPAPI_SEARCH_RESULT_MAX, serpapiSearchAdapter } from '../src/web-serpapi.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'serpapi-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { SERPAPI_KEY: SECRET },
    nativeAi: { summaries: false, answers: false },
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('serpapi configured: key present, blank and absent rejected', () => {
  assert.equal(serpapiSearchAdapter.id, 'serpapi');
  assert.equal(SERPAPI_SEARCH_RESULT_MAX, 20);
  assert.equal(serpapiSearchAdapter.configured({ SERPAPI_KEY: 'k' }), true);
  assert.equal(serpapiSearchAdapter.configured({ SERPAPI_KEY: '  ' }), false);
  assert.equal(serpapiSearchAdapter.configured({}), false);
});

test('serpapi unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic_results: [] }));
  try {
    const out = await serpapiSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'serpapi', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('serpapi exact endpoint, GET, query-key placement, engine/q/num', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic_results: [] }));
  try {
    await serpapiSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init?.method ?? 'GET', 'GET');
    const parsed = new URL(calls[0]!.url);
    assert.equal(parsed.origin + parsed.pathname, SERPAPI_SEARCH_ENDPOINT);
    assert.equal(parsed.searchParams.get('engine'), 'google');
    assert.equal(parsed.searchParams.get('q'), 'transformer interpretability');
    assert.equal(parsed.searchParams.get('api_key'), SECRET);
    assert.equal(parsed.searchParams.get('num'), '5');
    assert.equal(parsed.searchParams.get('tbs'), null);
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    assert.ok(!Object.values(headers).join(' ').includes(SECRET), 'key must stay in query, not headers');
  } finally {
    restore();
  }
});

test('serpapi recency maps to tbs, domains rewrite q with site: plus headroom', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic_results: [] }));
  try {
    await serpapiSearchAdapter.search(input({ recency: 'week', domains: ['example.com', '-evil.com'] }));
    assert.equal(calls.length, 1);
    const parsed = new URL(calls[0]!.url);
    assert.equal(parsed.searchParams.get('tbs'), 'qdr:w');
    assert.equal(parsed.searchParams.get('q'), 'transformer interpretability site:example.com -site:evil.com');
    assert.equal(parsed.searchParams.get('num'), '10');
  } finally {
    restore();
  }
});

test('serpapi num capped at 20, multi-include uses OR group', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ organic_results: [] }));
  try {
    await serpapiSearchAdapter.search(input({ limit: 50, domains: ['a.com', 'b.com'] }));
    const parsed = new URL(calls[0]!.url);
    assert.equal(parsed.searchParams.get('num'), '20');
    assert.ok(parsed.searchParams.get('q')!.includes('(site:a.com OR site:b.com)'));
  } finally {
    restore();
  }
});

test('serpapi maps organic_results, drops link-less rows, caps title/snippet', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      organic_results: [
        { title: 'T', link: 'https://example.com/a', snippet: 'excerpt' },
        { title: 'NoLink', snippet: 'x' },
        { title: `L${'o'.repeat(600)}`, link: 'https://example.com/b', snippet: `S${'n'.repeat(9000)}` },
      ],
    }),
  );
  try {
    const out = await serpapiSearchAdapter.search(input());
    assert.equal(out.backend, 'serpapi');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 2);
    assert.deepEqual(out.hits[0], {
      title: 'T',
      url: 'https://example.com/a',
      snippet: 'excerpt',
      backend: 'serpapi',
    });
    assert.equal(out.hits[1]!.title.length, 500);
    assert.equal(out.hits[1]!.snippet.length, 8000);
    assert.ok(!JSON.stringify(out).includes(SECRET), 'key must not leak into output');
  } finally {
    restore();
  }
});

test('serpapi 200 error envelope rejects without keyed URL', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ error: 'Invalid API key' }));
  try {
    await assert.rejects(() => serpapiSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SECRET), 'key must not leak into error');
      assert.ok(!error.message.includes('api_key='), 'keyed URL must not leak into error');
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('serpapi invalid top-level shapes reject', async () => {
  for (const body of [[], null, {}, { organic_results: {} }]) {
    const { restore } = mockFetch(async () => jsonResponse(body));
    try {
      await assert.rejects(() => serpapiSearchAdapter.search(input()), /invalid response/);
    } finally {
      restore();
    }
  }
});

test('serpapi 3xx rejects with one call', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
  );
  try {
    await assert.rejects(() => serpapiSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('serpapi 401/429/500 throw safe status-only errors, one call each', async () => {
  for (const status of [401, 429, 500]) {
    const { calls, restore } = mockFetch(async () => jsonResponse({ message: 'denied' }, status));
    try {
      await assert.rejects(() => serpapiSearchAdapter.search(input({ limit: 3 })), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `SerpApi search failed with HTTP ${status}`);
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  }
});

test('serpapi oversized JSON rejects safe', async () => {
  const { calls, restore } = mockFetch(
    async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }),
  );
  try {
    await assert.rejects(() => serpapiSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SECRET), 'key must not leak into error');
      assert.ok(!error.message.includes('api_key='), 'keyed URL must not leak into error');
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('serpapi caller abort propagates', async () => {
  const controller = new AbortController();
  controller.abort();
  const { restore } = mockFetch(async () => jsonResponse({ organic_results: [] }));
  try {
    await assert.rejects(() => serpapiSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});

test('serpapi empty organic_results succeeds empty', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ organic_results: [] }));
  try {
    const out = await serpapiSearchAdapter.search(input());
    assert.deepEqual(out, { backend: 'serpapi', hits: [], generatedText: [] });
  } finally {
    restore();
  }
});
