import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DUCKDUCKGO_SEARCH_URL, duckduckgoSearchAdapter } from '../src/web-duckduckgo.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 5,
    env: {},
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

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

function ddgHtml(entries: Array<{ title: string; url: string; snippet: string }>): string {
  return `<html><body>${entries
    .map(
      (entry) =>
        `<div><a class="result__a" href="${entry.url}">${entry.title}</a>` +
        `<a class="result__snippet" href="${entry.url}">${entry.snippet}</a></div>`,
    )
    .join('')}</body></html>`;
}

test('duckduckgo is always configured (no credentials)', () => {
  assert.equal(duckduckgoSearchAdapter.id, 'duckduckgo');
  assert.equal(DUCKDUCKGO_SEARCH_URL, 'https://duckduckgo.com/html/');
  assert.equal(duckduckgoSearchAdapter.configured({}), true);
});

test('duckduckgo single html request with q param', async () => {
  const { calls, restore } = mockFetch(async () => htmlResponse('<html><body></body></html>'));
  try {
    const out = await duckduckgoSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    const parsed = new URL(calls[0]!.url);
    assert.equal(parsed.origin + parsed.pathname, 'https://duckduckgo.com/html/');
    assert.equal(parsed.searchParams.get('q'), 'transformer interpretability');
    assert.deepEqual(out, { backend: 'duckduckgo', hits: [], generatedText: [] });
  } finally {
    restore();
  }
});

test('duckduckgo redirect without location rejects, oversize rejects, caller abort propagates', async () => {
  const redirect = mockFetch(async () => new Response('', { status: 302 }));
  try {
    await assert.rejects(() => duckduckgoSearchAdapter.search(input()), /Redirect without Location/i);
    assert.equal(redirect.calls.length, 1);
  } finally {
    redirect.restore();
  }
  const big = mockFetch(async () => new Response('x', { status: 200, headers: { 'content-length': '2000000' } }));
  try {
    await assert.rejects(() => duckduckgoSearchAdapter.search(input()), /too large|exceeded size limit/i);
    assert.equal(big.calls.length, 1);
  } finally {
    big.restore();
  }
  const savedFetch = globalThis.fetch;
  globalThis.fetch = ((async (_url: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return htmlResponse('<html><body></body></html>');
  }) as typeof fetch);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => duckduckgoSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('duckduckgo parses pairs, strips html, decodes uddg redirects, honors limit', async () => {
  const uddg = `/d/?q=x&uddg=${encodeURIComponent('https://example.com/real')}`;
  const { restore } = mockFetch(async () =>
    htmlResponse(
      ddgHtml([
        { title: '<b>Bold</b> title', url: uddg, snippet: 'plain <em>snippet</em>' },
        { title: 'Second', url: 'https://example.com/b?a=1&amp;b=2', snippet: 'two' },
        { title: 'Third', url: 'https://example.com/c', snippet: 'three' },
      ]),
    ),
  );
  try {
    const out = await duckduckgoSearchAdapter.search(input({ limit: 2 }));
    assert.equal(out.backend, 'duckduckgo');
    assert.deepEqual(out.generatedText, []);
    assert.equal(out.hits.length, 2);
    assert.deepEqual(out.hits[0], {
      title: 'Bold title',
      url: 'https://example.com/real',
      snippet: 'plain snippet',
      backend: 'duckduckgo',
    });
    assert.equal(out.hits[1]!.url, 'https://example.com/b?a=1&b=2');
  } finally {
    restore();
  }
});
