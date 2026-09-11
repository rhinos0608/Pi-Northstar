import assert from 'node:assert/strict';
import { test } from 'node:test';

const ENV = { TAVILY_API_KEY: 'k' };
const ROOT = 'https://docs.example.com/guide/';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = saved;
  };
}

type LookupRow = { address: string; family: number };
const publicLookup = async (): Promise<LookupRow[]> => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async (): Promise<LookupRow[]> => [{ address: '10.0.0.5', family: 4 }];

test('sitemap registry: tavily configured check, none configured throws', async () => {
  const { SITEMAP_PROVIDERS, resolveSitemapProvider, tavilySitemapProvider } = await import('../src/web-sitemap.js');
  assert.equal(SITEMAP_PROVIDERS[0]?.id, 'tavily');
  assert.equal(tavilySitemapProvider.configured(ENV), true);
  assert.equal(tavilySitemapProvider.configured({}), false);
  assert.equal(tavilySitemapProvider.configured({ TAVILY_API_KEY: '  ' }), false);
  assert.throws(() => resolveSitemapProvider({}), /No sitemap-capable/);
  assert.equal(resolveSitemapProvider(ENV).id, 'tavily');
});

test('tavily map exact request: endpoint, method, headers, safe fixed body', async () => {
  const { mapTavilySite, TAVILY_MAP_ENDPOINT } = await import('../src/web-sitemap.js');
  assert.equal(TAVILY_MAP_ENDPOINT, 'https://api.tavily.com/map');
  let calls = 0;
  const restore = mockFetch(async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://api.tavily.com/map');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer k');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      url: ROOT,
      allow_external: false,
      limit: 10,
      timeout: 150,
    });
    assert.equal(init?.redirect, 'manual');
    return jsonResponse({ base_url: 'https://docs.example.com', results: ['https://docs.example.com/a'] });
  });
  try {
    const out = await mapTavilySite(ROOT, 10, ENV, undefined, publicLookup);
    assert.equal(out.provider, 'tavily');
    assert.equal(out.baseUrl, 'https://docs.example.com');
    assert.deepEqual(out.urls, ['https://docs.example.com/a']);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test('tavily map sends validated maxPages as limit', async () => {
  const { mapTavilySite } = await import('../src/web-sitemap.js');
  let body: unknown;
  const restore = mockFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return jsonResponse({ results: [] });
  });
  try {
    await mapTavilySite(ROOT, 25, ENV, undefined, publicLookup);
    assert.equal((body as { limit: number }).limit, 25);
  } finally {
    restore();
  }
});

test('tavily map normalizes: dedupe, http-only, same-origin enforced, capped', async () => {
  const { mapTavilySite } = await import('../src/web-sitemap.js');
  const results = [
    'https://docs.example.com/a',
    'https://docs.example.com/a',
    'https://evil.example.com/phish',
    'https://docs.example.com/b?x=1',
    'ftp://docs.example.com/file',
    'not-a-url',
    'https://sub.docs.example.com/c',
  ];
  const restore = mockFetch(async () => jsonResponse({ results }));
  try {
    const out = await mapTavilySite(ROOT, 10, ENV, undefined, publicLookup);
    assert.deepEqual(out.urls, ['https://docs.example.com/a', 'https://docs.example.com/b?x=1']);
  } finally {
    restore();
  }
});

test('tavily map rejects redirects, non-2xx, malformed shapes without secret echo', async () => {
  const { mapTavilySite } = await import('../src/web-sitemap.js');
  const key = 'tavily-map-secret-xyz';
  const attempt = async (response: Response): Promise<Error> => {
    const restore = mockFetch(async () => response);
    try {
      await mapTavilySite(ROOT, 10, { TAVILY_API_KEY: key }, undefined, publicLookup);
      assert.fail('expected map to throw');
    } catch (error) {
      assert.ok(error instanceof Error);
      return error;
    } finally {
      restore();
    }
  };
  assert.match((await attempt(new Response('', { status: 307, headers: { location: 'https://evil.example/' } }))).message, /Redirect rejected/);
  const http500 = await attempt(jsonResponse({ error: 'boom' }, 500));
  assert.match(http500.message, /HTTP 500/);
  assert.ok(!http500.message.includes(key));
  for (const shape of [{}, { results: 'nope' }, { results: {} }]) {
    const error = await attempt(jsonResponse(shape));
    assert.match(error.message, /invalid response/);
    assert.ok(!error.message.includes(key));
  }
});

test('tavily map tolerates non-string rows and ignores provider base_url', async () => {
  const { mapTavilySite } = await import('../src/web-sitemap.js');
  const restore = mockFetch(async () => jsonResponse({ base_url: 1, results: [7, null] }));
  try {
    const out = await mapTavilySite(ROOT, 10, ENV, undefined, publicLookup);
    assert.deepEqual(out.urls, []);
    assert.equal(out.baseUrl, 'https://docs.example.com');
  } finally {
    restore();
  }
});

test('tavily map never echoes malicious provider base_url', async () => {
  const { mapTavilySite } = await import('../src/web-sitemap.js');
  const restore = mockFetch(async () => jsonResponse({
    base_url: 'https://evil.example/phish',
    request_id: 'req-secret-1',
    usage: { credits: 9 },
    results: ['https://docs.example.com/a'],
  }));
  try {
    const out = await mapTavilySite(ROOT, 10, ENV, undefined, publicLookup);
    assert.equal(out.baseUrl, 'https://docs.example.com');
    assert.ok(!out.baseUrl.includes('evil'));
    assert.deepEqual(out.urls, ['https://docs.example.com/a']);
  } finally {
    restore();
  }
});

test('tavily map private DNS rejects before fetch', async () => {
  const { mapTavilySite } = await import('../src/web-sitemap.js');
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('must not fetch');
  }) as typeof fetch;
  try {
    await assert.rejects(() => mapTavilySite(ROOT, 10, ENV, undefined, privateLookup), /private\/reserved/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('runSitemap preserves provider order without query', async () => {
  const { runSitemap } = await import('../src/web-sitemap.js');
  const urls = ['https://docs.example.com/b', 'https://docs.example.com/a', 'https://docs.example.com/c'];
  const restore = mockFetch(async () => jsonResponse({ base_url: 'https://docs.example.com', results: urls }));
  try {
    const out = await runSitemap(ROOT, { env: { ...ENV, PI_SEARCH_EMBEDDING_ENABLED: '0' }, lookup: publicLookup });
    assert.equal(out.provider, 'tavily');
    assert.equal(out.baseUrl, 'https://docs.example.com');
    assert.deepEqual(out.urls, urls);
    assert.equal(out.ranking, 'provider');
  } finally {
    restore();
  }
});

test('runSitemap with query ranks via BM25 fallback when embeddings disabled', async () => {
  const { runSitemap } = await import('../src/web-sitemap.js');
  const urls = [
    'https://docs.example.com/getting-started-install',
    'https://docs.example.com/api-reference-map',
    'https://docs.example.com/changelog',
  ];
  const restore = mockFetch(async () => jsonResponse({ results: urls }));
  try {
    const out = await runSitemap(ROOT, {
      query: 'sitemap api map endpoint',
      env: { ...ENV, PI_SEARCH_EMBEDDING_ENABLED: '0' },
      lookup: publicLookup,
    });
    assert.equal(out.ranking, 'bm25');
    assert.deepEqual([...out.urls].sort(), [...urls].sort());
    assert.equal(out.urls[0], 'https://docs.example.com/api-reference-map');
  } finally {
    restore();
  }
});

test('runSitemap caps urls at validated maxPages and rejects out-of-range', async () => {
  const { runSitemap } = await import('../src/web-sitemap.js');
  const urls = Array.from({ length: 10 }, (_, i) => `https://docs.example.com/p${i}`);
  const restore = mockFetch(async () => jsonResponse({ results: urls }));
  try {
    const out = await runSitemap(ROOT, { maxPages: 3, env: ENV, lookup: publicLookup });
    assert.equal(out.urls.length, 3);
    await assert.rejects(() => runSitemap(ROOT, { maxPages: 26, env: ENV, lookup: publicLookup }), /maxPages/);
    await assert.rejects(() => runSitemap(ROOT, { maxPages: 0, env: ENV, lookup: publicLookup }), /maxPages/);
  } finally {
    restore();
  }
});

test('runSitemap empty map yields empty urls', async () => {
  const { runSitemap } = await import('../src/web-sitemap.js');
  const restore = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await runSitemap(ROOT, { env: ENV, lookup: publicLookup });
    assert.deepEqual(out.urls, []);
    assert.equal(out.ranking, 'provider');
  } finally {
    restore();
  }
});

test('runSitemap caller abort propagates instead of BM25 fallback', async () => {
  const { runSitemap } = await import('../src/web-sitemap.js');
  const restore = mockFetch(async () => jsonResponse({
    results: ['https://docs.example.com/a', 'https://docs.example.com/b'],
  }));
  try {
    const controller = new AbortController();
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(
      () => runSitemap(ROOT, { query: 'docs', env: ENV, signal: controller.signal, lookup: publicLookup }),
    );
  } finally {
    restore();
  }
});

test('runSitemap embedding failure falls back to BM25 with no log text', async () => {
  const { runSitemap } = await import('../src/web-sitemap.js');
  const urls = ['https://docs.example.com/api-reference-map', 'https://docs.example.com/changelog'];
  const restore = mockFetch(async (url) => {
    if (String(url).startsWith('http://127.0.0.1:1/')) {
      return new Response('down', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
    return jsonResponse({ results: urls });
  });
  const warnings: unknown[][] = [];
  const savedWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args);
  };
  try {
    const out = await runSitemap(ROOT, {
      query: 'sitemap api map endpoint',
      env: { ...ENV, EMBEDDING_SIDECAR_BASE_URL: 'http://127.0.0.1:1' },
      lookup: publicLookup,
    });
    assert.equal(out.ranking, 'bm25');
    assert.deepEqual([...out.urls].sort(), [...urls].sort());
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = savedWarn;
    restore();
  }
});

test('tavily map missing key rejects without fetch', async () => {
  const { mapTavilySite } = await import('../src/web-sitemap.js');
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('must not fetch');
  }) as typeof fetch;
  try {
    await assert.rejects(() => mapTavilySite(ROOT, 10, {}), /not configured/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved;
  }
});
