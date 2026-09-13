import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PARALLEL_API_KEY_MIN_LENGTH,
  PARALLEL_SEARCH_ENDPOINT,
  parallelSearchAdapter,
} from '../../../src/web/providers/web-parallel.js';
import type { WebProviderSearchInput } from '../../../src/web/web-search-types.js';

const SECRET = 'parallel-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 8,
    env: { PARALLEL_API_KEY: SECRET },
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

test('parallel configured: min-length gate, blank and absent rejected', () => {
  assert.equal(parallelSearchAdapter.id, 'parallel');
  assert.equal(PARALLEL_API_KEY_MIN_LENGTH, 8);
  assert.equal(parallelSearchAdapter.configured({ PARALLEL_API_KEY: '12345678' }), true);
  assert.equal(parallelSearchAdapter.configured({ PARALLEL_API_KEY: 'short' }), false);
  assert.equal(parallelSearchAdapter.configured({ PARALLEL_API_KEY: '  ' }), false);
  assert.equal(parallelSearchAdapter.configured({}), false);
});

test('parallel unconfigured and short-key calls return empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    assert.deepEqual(await parallelSearchAdapter.search(input({ env: {} })), {
      backend: 'parallel',
      hits: [],
      generatedText: [],
    });
    assert.deepEqual(
      await parallelSearchAdapter.search(input({ env: { PARALLEL_API_KEY: 'short' } })),
      { backend: 'parallel', hits: [], generatedText: [] },
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('parallel exact endpoint, method, headers, payload; max_results capped at 20', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await parallelSearchAdapter.search(input({ limit: 50 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, PARALLEL_SEARCH_ENDPOINT);
    assert.equal(new URL(calls[0]!.url).origin, 'https://api.parallel.ai');
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], SECRET);
    assert.equal(headers['Content-Type'], 'application/json');
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.objective, 'transformer interpretability');
    assert.deepEqual(body.search_queries, ['transformer interpretability']);
    assert.deepEqual(body.advanced_settings, { max_results: 20 });
  } finally {
    restore();
  }
});

test('parallel excerpts joined into snippet; generatedText always empty', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [
        { title: 'T', url: 'https://example.com/a', excerpts: ['first', 'second'] },
      ],
    }),
  );
  try {
    const out = await parallelSearchAdapter.search(input());
    assert.equal(out.backend, 'parallel');
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.title, 'T');
    assert.equal(out.hits[0]!.snippet, 'first\n\nsecond');
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('parallel unsupported filter fields stay unsent', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await parallelSearchAdapter.search(
      input({ recency: 'week', domains: ['example.com', '-blocked.example'], includeContent: true }),
    );
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['advanced_settings', 'objective', 'search_queries']);
    assert.ok(!JSON.stringify(body).includes('after_date'), 'after_date must not be sent');
    assert.ok(!JSON.stringify(body).includes('domain'), 'domain filters must not be sent');
  } finally {
    restore();
  }
});

test('parallel drops malformed rows, keeps valid siblings; invalid container rejects', async () => {
  const good = { title: 'G', url: 'https://example.com/g', excerpts: ['ok'] };
  const badRows = [
    { title: 'NoUrl', excerpts: ['x'] },
    { title: 'BadScheme', url: 'ftp://example.com/f', excerpts: ['x'] },
    'not-an-object',
    42,
  ];
  const { restore } = mockFetch(async () => jsonResponse({ results: [good, ...badRows] }));
  try {
    const out = await parallelSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/g');
  } finally {
    restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ nope: [] }));
  try {
    await assert.rejects(parallelSearchAdapter.search(input()), /invalid response/);
  } finally {
    m2.restore();
  }
});

test('parallel no retry, redacted error, redirect rejected, oversize rejected', async () => {
  const key = 'parallel-redact-check-123';
  const m1 = mockFetch(async () => new Response('boom', { status: 500 }));
  try {
    await assert.rejects(
      parallelSearchAdapter.search(input({ env: { PARALLEL_API_KEY: key } })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key), 'key leaked into error');
        return true;
      },
    );
    assert.equal(m1.calls.length, 1);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }));
  try {
    await assert.rejects(parallelSearchAdapter.search(input()), /Redirect rejected/);
  } finally {
    m2.restore();
  }
  const m3 = mockFetch(async () => new Response('unauthorized', { status: 401 }));
  try {
    await assert.rejects(parallelSearchAdapter.search(input()), /HTTP 401/);
    assert.equal(m3.calls.length, 1);
  } finally {
    m3.restore();
  }
  const big = 'x'.repeat(1_000_005);
  const m4 = mockFetch(async () => new Response(JSON.stringify({ results: [], pad: big }), { status: 200 }));
  try {
    await assert.rejects(parallelSearchAdapter.search(input()), /size limit|too large/i);
  } finally {
    m4.restore();
  }
});

test('parallel passes composed policy signal through with no extra cap', async () => {
  let seenSignal: AbortSignal | undefined;
  const { calls, restore } = mockFetch((_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonResponse({ results: [] });
  });
  try {
    const controller = new AbortController();
    const out = await parallelSearchAdapter.search(input({ signal: controller.signal }));
    assert.equal(calls.length, 1);
    assert.equal(out.backend, 'parallel');
    assert.equal(seenSignal, controller.signal);
  } finally {
    restore();
  }
});

test('parallel abort propagates', async () => {
  const { restore } = mockFetch(async () => {
    throw new DOMException('This operation was aborted', 'AbortError');
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(parallelSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
