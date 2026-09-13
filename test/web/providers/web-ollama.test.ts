import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OLLAMA_SEARCH_PATH, ollamaSearchAdapter } from '../../../src/web/providers/web-ollama.js';
import type { WebProviderSearchInput } from '../../../src/web/web-search-types.js';

const SECRET = 'ollama-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: { OLLAMA_SEARCH_BASE_URL: 'https://ollama.example/', OLLAMA_SEARCH_API_KEY: SECRET },
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

test('ollama configured: primary base, legacy fallback, blank/absent rejected', () => {
  assert.equal(ollamaSearchAdapter.id, 'ollama-search');
  assert.equal(OLLAMA_SEARCH_PATH, '/api/experimental/web_search');
  assert.equal(ollamaSearchAdapter.configured({ OLLAMA_SEARCH_BASE_URL: 'https://ollama.example' }), true);
  assert.equal(ollamaSearchAdapter.configured({ SEARCH_OLLAMA_BASE_URL: 'https://ollama.example' }), true);
  assert.equal(ollamaSearchAdapter.configured({ OLLAMA_SEARCH_BASE_URL: '  ' }), false);
  assert.equal(ollamaSearchAdapter.configured({}), false);
});

test('ollama unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await ollamaSearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'ollama-search', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('ollama posts query/max_results to operator base with bearer key', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await ollamaSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://ollama.example/api/experimental/web_search');
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, { query: 'transformer interpretability', max_results: 5 });
  } finally {
    restore();
  }
});

test('ollama legacy env names work and keyless base sends no auth header', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await ollamaSearchAdapter.search(
      input({ env: { SEARCH_OLLAMA_BASE_URL: 'https://ollama.example', SEARCH_OLLAMA_API_KEY: 'legacy-key' } }),
    );
    assert.equal(calls[0]!.url, 'https://ollama.example/api/experimental/web_search');
    assert.equal((calls[0]!.init?.headers as Record<string, string>).Authorization, 'Bearer legacy-key');
  } finally {
    restore();
  }
  const second = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await ollamaSearchAdapter.search(input({ env: { OLLAMA_SEARCH_BASE_URL: 'https://ollama.example' } }));
    assert.equal('Authorization' in ((second.calls[0]!.init?.headers as Record<string, string>) ?? {}), false);
  } finally {
    second.restore();
  }
});

test('ollama maps results title/url/content, drops empty urls', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [
        { title: 'A', url: 'https://example.com/a', content: 'excerpt a' },
        { title: 'NoUrl', url: '', content: 'x' },
      ],
    }),
  );
  try {
    const out = await ollamaSearchAdapter.search(input());
    assert.equal(out.backend, 'ollama-search');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.hits[0], {
      title: 'A',
      url: 'https://example.com/a',
      snippet: 'excerpt a',
      backend: 'ollama-search',
    });
    assert.ok(!JSON.stringify(out).includes(SECRET), 'key must not leak into output');
  } finally {
    restore();
  }
});

test('ollama upstream error rejects without key material', async () => {
  const { restore } = mockFetch(async () => jsonResponse({ error: 'boom' }, 500));
  try {
    await assert.rejects(() => ollamaSearchAdapter.search(input()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 500 for Ollama search/);
      assert.ok(!error.message.includes(SECRET), 'key must not leak into error');
      return true;
    });
  } finally {
    restore();
  }
});
