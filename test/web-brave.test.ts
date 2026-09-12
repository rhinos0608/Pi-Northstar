import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAVE_SEARCH_ENDPOINT, BRAVE_SEARCH_RESULT_MAX, braveSearchAdapter } from '../src/web-brave.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'brave-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { BRAVE_API_KEY: SECRET },
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

test('brave configured: key present, blank and absent rejected', () => {
  assert.equal(braveSearchAdapter.id, 'brave');
  assert.equal(BRAVE_SEARCH_RESULT_MAX, 20);
  assert.equal(braveSearchAdapter.configured({ BRAVE_API_KEY: 'k' }), true);
  assert.equal(braveSearchAdapter.configured({ BRAVE_API_KEY: '  ' }), false);
  assert.equal(braveSearchAdapter.configured({}), false);
});

test('brave unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ web: { results: [] } }));
  try {
    const out = await braveSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'brave', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('brave exact endpoint, method, headers, query params', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ web: { results: [] } }));
  try {
    await braveSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    const parsed = new URL(calls[0]!.url);
    assert.equal(parsed.origin + parsed.pathname, BRAVE_SEARCH_ENDPOINT);
    assert.equal(parsed.searchParams.get('q'), 'transformer interpretability');
    assert.equal(parsed.searchParams.get('count'), '5');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['X-Subscription-Token'], SECRET);
    assert.equal(headers.Accept, 'application/json');
  } finally {
    restore();
  }
});

test('brave count capped at 20', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ web: { results: [] } }));
  try {
    await braveSearchAdapter.search(input({ limit: 50 }));
    assert.equal(new URL(calls[0]!.url).searchParams.get('count'), '20');
  } finally {
    restore();
  }
});

test('brave maps web.results title/url/description, drops empty urls', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      web: {
        results: [
          { title: 'T', url: 'https://example.com/a', description: 'brave excerpt' },
          { title: 'NoUrl', url: '', description: 'x' },
        ],
      },
    }),
  );
  try {
    const out = await braveSearchAdapter.search(input());
    assert.equal(out.backend, 'brave');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.hits[0], {
      title: 'T',
      url: 'https://example.com/a',
      snippet: 'brave excerpt',
      backend: 'brave',
    });
    assert.ok(!JSON.stringify(out).includes(SECRET), 'key must not leak into output');
  } finally {
    restore();
  }
});

test('brave missing web envelope returns empty hits', async () => {
  const { restore } = mockFetch(async () => jsonResponse({}));
  try {
    const out = await braveSearchAdapter.search(input());
    assert.deepEqual(out.hits, []);
  } finally {
    restore();
  }
});

test('brave json error envelope resolves empty (fetchJson never gates on status)', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ message: 'forbidden' }, 401));
  try {
    const out = await braveSearchAdapter.search(input());
    assert.deepEqual(out.hits, []);
  } finally {
    restore();
  }
});

test('brave redirect without location rejects, oversize rejects, caller abort propagates', async () => {
  const redirect = mockFetch(async () => new Response('', { status: 302 }));
  try {
    await assert.rejects(() => braveSearchAdapter.search(input()), /Redirect without Location/i);
    assert.equal(redirect.calls.length, 1);
  } finally {
    redirect.restore();
  }
  const big = mockFetch(async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }));
  try {
    await assert.rejects(() => braveSearchAdapter.search(input()), /too large|exceeded size limit/i);
    assert.equal(big.calls.length, 1);
  } finally {
    big.restore();
  }
  const saved = globalThis.fetch;
  globalThis.fetch = ((async (_url: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return jsonResponse({ web: { results: [] } });
  }) as typeof fetch);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => braveSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    globalThis.fetch = saved;
  }
});

test('brave malformed body rejects without key material', async () => {
  const { restore } = mockFetch(async () => new Response('not-json{{{', { status: 200 }));
  try {
    await assert.rejects(() => braveSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SECRET), 'key must not leak into error');
      return true;
    });
  } finally {
    restore();
  }
});
