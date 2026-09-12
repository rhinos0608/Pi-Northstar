import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VALYU_SEARCH_ENDPOINT, VALYU_SEARCH_RESULT_MAX, valyuSearchAdapter } from '../src/web-valyu.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'valyu-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { VALYU_API_KEY: SECRET },
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
  { title: 'T', url: 'https://example.com/a', description: 'short', content: 'long content' },
]): unknown {
  return { success: true, results: rows };
}

test('valyu configured: key present, blank and absent rejected', () => {
  assert.equal(valyuSearchAdapter.id, 'valyu');
  assert.equal(VALYU_SEARCH_RESULT_MAX, 20);
  assert.equal(valyuSearchAdapter.configured({ VALYU_API_KEY: 'k' }), true);
  assert.equal(valyuSearchAdapter.configured({ VALYU_API_KEY: '  ' }), false);
  assert.equal(valyuSearchAdapter.configured({}), false);
});

test('valyu unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const out = await valyuSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'valyu', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('valyu exact endpoint, method, headers, minimal body', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await valyuSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, VALYU_SEARCH_ENDPOINT);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.redirect, 'manual');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], SECRET);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      query: 'transformer interpretability',
      max_num_results: 5,
    });
  } finally {
    restore();
  }
});

test('valyu max_num_results capped at 20', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  try {
    await valyuSearchAdapter.search(input({ limit: 50 }));
    assert.equal(JSON.parse(String(calls[0]!.init?.body)).max_num_results, 20);
  } finally {
    restore();
  }
});

test('valyu content preferred with full kind, description fallback, bad urls dropped', async () => {
  const { restore } = mockFetch(async () => jsonResponse(okBody([
    { title: 'T', url: 'https://example.com/a', description: 'short', content: 'long content' },
    { title: 'D', url: 'https://example.com/b', description: 'only description' },
    { title: 'NoUrl', url: '', description: 'x', content: 'y' },
  ])));
  try {
    const out = await valyuSearchAdapter.search(input());
    assert.equal(out.backend, 'valyu');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 2);
    assert.deepEqual(out.hits[0], {
      title: 'T',
      url: 'https://example.com/a',
      snippet: 'long content',
      backend: 'valyu',
      contentKind: 'full',
    });
    assert.deepEqual(out.hits[1], {
      title: 'D',
      url: 'https://example.com/b',
      snippet: 'only description',
      backend: 'valyu',
    });
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally {
    restore();
  }
});

test('valyu sends sources + start_date filters', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(okBody([])));
  const beforeDay = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  try {
    await valyuSearchAdapter.search(input({
      recency: 'week',
      domains: ['example.com', '-blocked.com'],
    }));
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.deepEqual(body.included_sources, ['example.com']);
    assert.deepEqual(body.excluded_sources, ['blocked.com']);
    // Midnight-UTC flake guard: accept the date computed from either side of the call.
    const afterDay = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    assert.ok(body.start_date === beforeDay || body.start_date === afterDay, `start_date ${body.start_date} not adjacent to ${beforeDay}`);
  } finally {
    restore();
  }
});

test('valyu success:false rejects', async () => {
  const { calls, restore } = mockFetch(async () =>
    jsonResponse({ success: false, results: [], error: 'bad key' }));
  try {
    await assert.rejects(() => valyuSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('valyu missing results array rejects', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ success: true }));
  try {
    await assert.rejects(() => valyuSearchAdapter.search(input()), /invalid response/);
  } finally {
    restore();
  }
});

test('valyu 3xx rejects', async () => {
  const { calls, restore } = mockFetch(async () => new Response(null, { status: 302 }));
  try {
    await assert.rejects(() => valyuSearchAdapter.search(input()), /Redirect rejected/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

for (const status of [401, 429, 500]) {
  test(`valyu HTTP ${status}: one call, safe status-only error`, async () => {
    const { calls, restore } = mockFetch(async () => jsonResponse({ error: 'x' }, status));
    try {
      await assert.rejects(() => valyuSearchAdapter.search(input()), (error: unknown) => {
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

test('valyu oversized JSON rejects', async () => {
  const { restore } = mockFetch(async () =>
    new Response(JSON.stringify(okBody()), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2_000_000) },
    }));
  try {
    await assert.rejects(() => valyuSearchAdapter.search(input()), /too large|exceeded size/i);
  } finally {
    restore();
  }
});

test('valyu caller abort propagates', async () => {
  const { restore } = mockFetch(async () => jsonResponse(okBody()));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => valyuSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
