import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searxngSearchAdapter } from '../src/web-searxng.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { SEARXNG_BASE_URL: 'https://searxng.example/' },
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

test('searxng configured: base present, blank and absent rejected', () => {
  assert.equal(searxngSearchAdapter.id, 'searxng');
  assert.equal(searxngSearchAdapter.configured({ SEARXNG_BASE_URL: 'https://searxng.example' }), true);
  assert.equal(searxngSearchAdapter.configured({ SEARXNG_BASE_URL: '  ' }), false);
  assert.equal(searxngSearchAdapter.configured({}), false);
});

test('searxng unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await searxngSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'searxng', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('searxng trims trailing slashes, sets q/format/safesearch params', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await searxngSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    const parsed = new URL(calls[0]!.url);
    assert.equal(parsed.origin + parsed.pathname, 'https://searxng.example/search');
    assert.equal(parsed.searchParams.get('q'), 'transformer interpretability');
    assert.equal(parsed.searchParams.get('format'), 'json');
    assert.equal(parsed.searchParams.get('safesearch'), '1');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Accept, 'application/json');
  } finally {
    restore();
  }
});

test('searxng maps results title/url/content, drops empty urls, honors limit', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [
        { title: 'A', url: 'https://example.com/a', content: 'excerpt a' },
        { title: 'B', url: 'https://example.com/b', content: 'excerpt b' },
        { title: 'NoUrl', url: '', content: 'x' },
      ],
    }),
  );
  try {
    const out = await searxngSearchAdapter.search(input({ limit: 2 }));
    assert.equal(out.backend, 'searxng');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 2);
    assert.deepEqual(out.hits[0], {
      title: 'A',
      url: 'https://example.com/a',
      snippet: 'excerpt a',
      backend: 'searxng',
    });
  } finally {
    restore();
  }
});

test('searxng redirect rejects, oversize rejects, caller abort propagates', async () => {
  const redirect = mockFetch(async () => new Response('', { status: 302 }));
  try {
    await assert.rejects(() => searxngSearchAdapter.search(input()), /HTTP 302/);
    assert.equal(redirect.calls.length, 1);
  } finally {
    redirect.restore();
  }
  const big = mockFetch(async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }));
  try {
    await assert.rejects(() => searxngSearchAdapter.search(input()), /too large|exceeded size limit/i);
    assert.equal(big.calls.length, 1);
  } finally {
    big.restore();
  }
  const savedFetch = globalThis.fetch;
  globalThis.fetch = ((async (_url: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return jsonResponse({ results: [] });
  }) as typeof fetch);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => searxngSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('searxng upstream error rejects without base echo beyond url', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ error: 'boom' }, 500));
  try {
    await assert.rejects(() => searxngSearchAdapter.search(input()));
  } finally {
    restore();
  }
});
