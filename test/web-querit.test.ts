import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUERIT_SEARCH_ENDPOINT, QUERIT_SEARCH_RESULT_MAX, queritSearchAdapter } from '../src/web-querit.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'querit-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { QUERIT_API_KEY: SECRET },
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
    init?.signal?.throwIfAborted();
    calls.push({ url: String(url), init });
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

function okBody(rows: unknown[] = [
  { url: 'https://example.com/a', title: 'T', snippet: 'querit excerpt', page_age: '2 days' },
]): unknown {
  return { error_code: 200, results: { result: rows } };
}

test('querit configured: key present, blank and absent rejected', () => {
  assert.equal(queritSearchAdapter.id, 'querit');
  assert.equal(QUERIT_SEARCH_RESULT_MAX, 20);
  assert.equal(queritSearchAdapter.configured({ QUERIT_API_KEY: 'k' }), true);
  assert.equal(queritSearchAdapter.configured({ QUERIT_API_KEY: '  ' }), false);
  assert.equal(queritSearchAdapter.configured({}), false);
});

test('querit unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const out = await queritSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'querit', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('querit exact endpoint, method, headers, minimal body', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await queritSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, QUERIT_SEARCH_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.redirect, 'manual');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      query: 'transformer interpretability',
      count: 5,
    });
  } finally {
    restore();
  }
});

test('querit count capped at 20', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await queritSearchAdapter.search(input({ limit: 50 }));
    assert.equal(JSON.parse(String(calls[0]!.init?.body)).count, 20);
  } finally {
    restore();
  }
});

test('querit maps results.result, drops bad urls and page_age', async () => {
  const { restore } = mockFetch(async () => jsonResponse(okBody([
    { url: 'https://example.com/a', title: 'T', snippet: 'querit excerpt', page_age: '2 days' },
    { url: '', title: 'NoUrl', snippet: 'x' },
    { url: 'notaurl', title: 'Bad', snippet: 'y' },
  ])));
  try {
    const out = await queritSearchAdapter.search(input());
    assert.equal(out.backend, 'querit');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.hits[0], {
      title: 'T',
      url: 'https://example.com/a',
      snippet: 'querit excerpt',
      backend: 'querit',
    });
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally {
    restore();
  }
});

test('querit sends sites + timeRange filters, never from', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await queritSearchAdapter.search(input({
      recency: 'week',
      domains: ['example.com', '-blocked.com'],
    }));
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.deepEqual(body.filters, {
      sites: { include: ['example.com'], exclude: ['blocked.com'] },
      timeRange: { date: 'w1' },
    });
    assert.ok(!('from' in body));
  } finally {
    restore();
  }
});

test('querit business error_code rejects without key material', async () => {
  const { calls, restore } = mockFetch(async () =>
    jsonResponse({ error_code: 429, error_msg: 'too many requests', results: { result: [] } }));
  try {
    await assert.rejects(() => queritSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /429/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('querit missing results.result array rejects', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ error_code: 200, results: {} }));
  try {
    await assert.rejects(() => queritSearchAdapter.search(input()), /invalid response/);
  } finally {
    restore();
  }
});

test('querit 3xx rejects', async () => {
  const { calls, restore } = mockFetch(async () => new Response(null, { status: 302 }));
  try {
    await assert.rejects(() => queritSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

for (const status of [401, 429, 500]) {
  test(`querit HTTP ${status}: one call, safe status-only error`, async () => {
    const { calls, restore } = mockFetch(async () => jsonResponse({ error: 'x' }, status));
    try {
      await assert.rejects(() => queritSearchAdapter.search(input()), (error: unknown) => {
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

test('querit oversized JSON rejects', async () => {
  const { restore } = mockFetch(async () =>
    new Response(JSON.stringify(okBody()), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2_000_000) },
    }));
  try {
    await assert.rejects(() => queritSearchAdapter.search(input()), /too large|exceeded size/i);
  } finally {
    restore();
  }
});

test('querit caller abort propagates', async () => {
  const { restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => queritSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
