import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import { fetchReadablePage } from '../src/web.js';

function invalidRequestCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

async function withFetch<T>(
  mock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
  }
}

/** Direct page fetcher for the fetchPageText seam: real HTTP, no SSRF validation. */
async function localFetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function startServer(pages: Record<string, string>): Promise<{ server: Server; baseUrl: string }> {
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    const body = pages[path];
    if (body) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const NO_EMBEDDING = { PI_SEARCH_EMBEDDING_ENABLED: '0' };

// ── web_search backend behavior (moved from native-tools.test.ts) ──

test('native web_search fans out configured backends and fuses duplicate URLs with RRF', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.duckduckgo.com/')) {
      return new Response(JSON.stringify({
        Heading: 'Example',
        AbstractURL: 'https://example.com/page?utm_source=ddg',
        AbstractText: 'Duck result',
        RelatedTopics: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://api.search.brave.com/')) {
      return new Response(JSON.stringify({
        web: { results: [{ title: 'Example brave', url: 'https://www.example.com/page', description: 'Brave result' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, { env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo,brave', BRAVE_API_KEY: 'key' } });
    const details = result.details as { results: Array<{ url: string; rrfScore?: number }>; fusion: { backends: string[] } };

    assert.equal(details.results.length, 1);
    assert.deepEqual(details.fusion.backends.sort(), ['brave', 'duckduckgo']);
    assert.ok((details.results[0]?.rrfScore ?? 0) > 0.03);
  });
});

test('native web_search sends auth headers for POST backends', async () => {
  const cases = [
    {
      backend: 'exa',
      env: { PI_SEARCH_WEB_BACKENDS: 'exa', EXA_API_KEY: 'exa-key' },
      expectedUrl: 'https://api.exa.ai/search',
      expectedHeaders: { 'x-api-key': 'exa-key', 'Content-Type': 'application/json' },
      response: { results: [{ title: 'Exa', url: 'https://exa.example', summary: 'ok' }] },
    },
    {
      backend: 'tavily',
      env: { PI_SEARCH_WEB_BACKENDS: 'tavily', TAVILY_API_KEY: 'tav-key' },
      expectedUrl: 'https://api.tavily.com/search',
      expectedHeaders: { Authorization: 'Bearer tav-key', 'Content-Type': 'application/json' },
      response: { results: [{ title: 'Tavily', url: 'https://tavily.example', content: 'ok' }] },
    },
    {
      backend: 'ollama-search',
      env: { PI_SEARCH_WEB_BACKENDS: 'ollama-search', OLLAMA_SEARCH_BASE_URL: 'https://ollama.example', OLLAMA_SEARCH_API_KEY: 'ollama-key' },
      expectedUrl: 'https://ollama.example/api/experimental/web_search',
      expectedHeaders: { Authorization: 'Bearer ollama-key', 'Content-Type': 'application/json' },
      response: { results: [{ title: 'Ollama', url: 'https://ollama-result.example', content: 'ok' }] },
    },
  ];

  for (const item of cases) {
    let observedUrl = '';
    let observedHeaders: Record<string, string> = {};
    await withFetch(async (input, init) => {
      observedUrl = String(input);
      observedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(item.response), { status: 200, headers: { 'content-type': 'application/json' } });
    }, async () => {
      const result = await callNativeTool('web_search', { query: 'example' }, { env: item.env });
      assert.match(JSON.stringify(result.details), new RegExp(item.backend));
      assert.equal(observedUrl, item.expectedUrl);
      for (const [key, value] of Object.entries(item.expectedHeaders)) {
        assert.equal(observedHeaders[key], value);
      }
    });
  }
});

test('native web_search rejects invalid or unconfigured explicit backend override', async () => {
  await assert.rejects(
    () => callNativeTool('web_search', { query: 'example' }, { env: { PI_SEARCH_WEB_BACKENDS: 'bogus' } }),
    /No known web search backends/,
  );
  await assert.rejects(
    () => callNativeTool('web_search', { query: 'example' }, { env: { PI_SEARCH_WEB_BACKENDS: 'exa' } }),
    /not configured/,
  );
});

// ── Contract-first rejection: no backend spawn on invalid input ──

test('native web_search rejects out-of-range limit with invalid_request before any backend call', async () => {
  for (const limit of [21, 100000, 0]) {
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }, async () => {
      await assert.rejects(
        callNativeTool('web_search', { query: 'example', limit }, { env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo,brave', BRAVE_API_KEY: 'key' } }),
        (err: unknown) => invalidRequestCode(err) === 'invalid_request',
        `limit ${limit} must reject with invalid_request`,
      );
    });
    assert.equal(calls, 0, `limit ${limit} must not spawn any backend call`);
  }
});

test('native web_search rejects unknown backends before any network call', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }, async () => {
    await assert.rejects(
      () => callNativeTool('web_search', { query: 'example' }, { env: { PI_SEARCH_WEB_BACKENDS: 'bogus' } }),
      /No known web search backends/,
    );
  });
  assert.equal(calls, 0, 'unknown backend must not spawn any network call');
});

test('legacy SEARCH_WEB_BACKENDS flag is ignored; PI_SEARCH_WEB_BACKENDS is the only override', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.duckduckgo.com/')) {
      return new Response(JSON.stringify({ Heading: 'H', AbstractURL: 'https://example.com/x', AbstractText: 't', RelatedTopics: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    // SEARCH_WEB_BACKENDS=bogus alone must not throw: the dual-flag path is deleted.
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, { env: { SEARCH_WEB_BACKENDS: 'bogus' } });
    assert.match(JSON.stringify(result.details), /example\.com/);
  });
});

// ── Envelope normalization: article entities, no raw passthrough ──

test('web_search success builds normalized article entities with a northstar envelope', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.duckduckgo.com/')) {
      return new Response(JSON.stringify({
        Heading: '',
        AbstractURL: '',
        AbstractText: '',
        RelatedTopics: [
          { Text: 'First hit - more', FirstURL: 'https://example.com/a' },
          { Text: 'Second hit', FirstURL: 'https://example.com/b' },
        ],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, { env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo' } });
    const details = result.details as {
      results: Array<{ title: string; url: string; snippet: string; source: string }>;
      northstar: {
        data: { kind: string; entities: Array<{ kind: string; title: string; url: string; snippet?: string }> };
        sources: Array<{ backend: string }>;
      };
    };
    // Legacy results are normalized entities, not raw passthrough.
    for (const item of details.results) {
      assert.equal(typeof item.title, 'string');
      assert.ok(item.title.length > 0, 'title falls back, never empty');
      assert.equal(typeof item.url, 'string');
      assert.equal(typeof item.snippet, 'string');
      assert.equal(typeof item.source, 'string');
    }
    // Canonical envelope carries validated article entities.
    assert.equal(details.northstar.data.kind, 'entities');
    assert.ok(details.northstar.data.entities.length > 0);
    for (const entity of details.northstar.data.entities) {
      assert.equal(entity.kind, 'article');
      assert.ok(entity.url.startsWith('https://'));
    }
    assert.ok(details.northstar.sources.some((s) => s.backend === 'duckduckgo'));
    // No raw backend_text fields anywhere on web paths.
    assert.doesNotMatch(JSON.stringify(result), /backend_text/);
  });
});

// ── Crawl BFS via local http server (restored with the fetchPageText seam) ──

test('followLinks crawl visits same-domain pages and skips external', async () => {
  let externalRequestCount = 0;
  const externalServer: Server = createServer((_req, res) => {
    externalRequestCount++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>External</h1><p>External content from other domain.</p></body></html>');
  });
  await new Promise<void>((resolve) => externalServer.listen(0, '127.0.0.1', () => resolve()));
  const extAddr = externalServer.address();
  if (!extAddr || typeof extAddr === 'string') throw new Error('Failed to get external server address');
  // Use localhost hostname so the domain check (rootHost=127.0.0.1) rejects it
  const externalUrl = `http://localhost:${extAddr.port}/other`;

  const pages: Record<string, string> = {
    '/': `<html><body><h1>Home</h1><p>Welcome to the homepage. This page contains general information about our site and services we provide to customers.</p><a href="/about">About</a> <a href="/contact">Contact</a> <a href="${externalUrl}">External</a></body></html>`,
    '/about': '<html><body><h1>About</h1><p>About page content. Learn more about our history, mission, and values. We have been serving customers since the early days of the internet and continue to grow.</p><a href="/">Home</a></body></html>',
    '/contact': '<html><body><h1>Contact</h1><p>Contact info. Reach out to us via email or phone. Our office is open Monday through Friday from nine to five.</p></body></html>',
  };
  const { server, baseUrl } = await startServer(pages);

  try {
    const result = await callNativeTool('fetch', {
      url: baseUrl + '/',
      // 'about' is a BM25 stopword, so BM25-only mode would drop the about
      // page entirely. Use non-stopword terms present on all three pages.
      query: 'page contact',
      followLinks: true,
      maxPages: 10,
    }, { fetchPageText: localFetchText, env: { ...NO_EMBEDDING } });
    const text = JSON.stringify(result);
    // Should find content from all 3 same-domain pages
    assert.match(text, /Welcome to the homepage/i, 'should include home page content');
    assert.match(text, /About page content/i, 'should include about page content');
    assert.match(text, /Contact info/i, 'should include contact page content');
    // Should NOT include external domain content
    assert.doesNotMatch(text, /External.*other/, 'should not include external domain content');
    // External server should not have received any requests (different hostname)
    assert.equal(externalRequestCount, 0, 'external domain should not be crawled');
  } finally {
    await closeServer(server);
    await closeServer(externalServer);
  }
});

test('followLinks crawl deduplicates normalized URLs', async () => {
  let pageCount = 0;
  const counting: Server = createServer((_req, res) => {
    pageCount++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Page</h1><p>This page contains enough content to be chunked and indexed properly for testing deduplication behavior.</p><a href="/">Self link</a></body></html>');
  });
  await new Promise<void>((resolve) => counting.listen(0, '127.0.0.1', () => resolve()));
  const addr = counting.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await callNativeTool('fetch', {
      url: baseUrl + '/',
      query: 'page',
      followLinks: true,
      maxPages: 10,
    }, { fetchPageText: localFetchText, env: { ...NO_EMBEDDING } });
    // Should only fetch the page once despite self-link
    assert.equal(pageCount, 1, 'should dedup self-referencing URL');
  } finally {
    await closeServer(counting);
  }
});

test('followLinks crawl respects maxPages limit', async () => {
  const pages: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    pages[`/p${i}`] = `<html><body><h1>Page ${i}</h1><p>This is page number ${i} with enough content to exceed the minimum chunk size requirement for proper testing of the crawl pipeline and page limits.</p><a href="/p${(i + 1) % 5}">Next</a></body></html>`;
  }
  let fetchCount = 0;
  const counted: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    const body = pages[path];
    if (body) {
      fetchCount++;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  await new Promise<void>((resolve) => counted.listen(0, '127.0.0.1', () => resolve()));
  const addr = counted.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await callNativeTool('fetch', {
      url: baseUrl + '/p0',
      query: 'page content',
      followLinks: true,
      maxPages: 3,
    }, { fetchPageText: localFetchText, env: { ...NO_EMBEDDING } });
    assert.ok(fetchCount <= 3, `should respect maxPages=3, got ${fetchCount}`);
  } finally {
    await closeServer(counted);
  }
});

test('followLinks crawl respects maxDepth via custom maxDepth', async () => {
  // Pages: /d0 -> /d1 -> /d2 -> /d3
  const pages: Record<string, string> = {
    '/d0': '<html><body><h1>Depth 0</h1><p>This is the first page in our depth chain. It contains links that go deeper into the site structure for testing purposes.</p><a href="/d1">Next</a></body></html>',
    '/d1': '<html><body><h1>Depth 1</h1><p>This is the second page in our depth chain. Content at depth one provides navigation to deeper levels of the site.</p><a href="/d2">Next</a></body></html>',
    '/d2': '<html><body><h1>Depth 2</h1><p>This is the third page in our depth chain. Content at depth two provides navigation to even deeper levels.</p><a href="/d3">Next</a></body></html>',
    '/d3': '<html><body><h1>Depth 3</h1><p>This is the deepest page in our depth chain. Content at the maximum depth level has no further links to follow.</p></body></html>',
  };
  const visitedPaths = new Set<string>();
  const tracked: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    const body = pages[path];
    if (body) {
      visitedPaths.add(path);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  await new Promise<void>((resolve) => tracked.listen(0, '127.0.0.1', () => resolve()));
  const addr = tracked.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // maxPages: 20, so the depth limit is what constrains
    await callNativeTool('fetch', {
      url: baseUrl + '/d0',
      query: 'depth content',
      followLinks: true,
      maxPages: 20,
    }, { fetchPageText: localFetchText, env: { ...NO_EMBEDDING } });
    // Default maxDepth is 3 for followLinks, so /d0 (depth 0) -> /d1 (1) -> /d2 (2) -> /d3 (3) should all be visited
    assert.ok(visitedPaths.has('/d0'));
    assert.ok(visitedPaths.has('/d1'));
    assert.ok(visitedPaths.has('/d2'));
    assert.ok(visitedPaths.has('/d3'));
  } finally {
    await closeServer(tracked);
  }
});

// ── maxChars honored on both read and crawl paths ──

test('read path honors maxChars', async () => {
  const body = `<html><head><title>Long page</title></head><body><p>${'alpha beta gamma delta content words '.repeat(200)}</p></body></html>`;
  const { server, baseUrl } = await startServer({ '/': body });
  try {
    const result = await callNativeTool('agentic_browse', { action: 'read', url: baseUrl + '/' }, { fetchPageText: localFetchText });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.ok(text.length <= 12000, `default maxChars bounds read text, got ${text.length}`);
    const small = await callNativeTool(
      'agentic_browse',
      { action: 'read', url: baseUrl + '/', maxChars: 100 },
      { fetchPageText: localFetchText },
    );
    const smallText = (small.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.ok(smallText.length <= 100, `explicit maxChars bounds read text, got ${smallText.length}`);
    assert.equal((small.details as { truncated?: boolean }).truncated, true);
  } finally {
    await closeServer(server);
  }
});

test('crawl path honors maxChars', async () => {
  const body = `<html><head><title>Crawl page</title></head><body><p>${'crawl target words '.repeat(200)}</p></body></html>`;
  const { server, baseUrl } = await startServer({ '/': body });
  try {
    const result = await callNativeTool('semantic_crawl', {
      source: { type: 'url', url: baseUrl + '/' },
      query: 'crawl target',
      maxChars: 100,
    }, { fetchPageText: localFetchText, env: { ...NO_EMBEDDING } });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.ok(text.length <= 100, `maxChars bounds crawl text, got ${text.length}`);
    assert.equal((result.details as { truncated?: boolean }).truncated, true);
    assert.equal((result.details as { maxChars?: number }).maxChars, 100);
  } finally {
    await closeServer(server);
  }
});

test('direct research path rejects out-of-range limit with invalid_request instead of clamping', async () => {
  for (const limit of [0, 31, 100]) {
    await assert.rejects(
      callNativeTool('research', { action: 'academic', query: 'attention', source: 'all', limit }),
      (err: unknown) => invalidRequestCode(err) === 'invalid_request',
      `research limit ${limit} must reject with invalid_request`,
    );
  }
});

test('web_search direct call with cursor rejects cursor_invalid instead of ignoring it', async () => {
  await assert.rejects(
    callNativeTool('web_search', { query: 'example', cursor: 'opaque-token' }),
    (err: unknown) => (err as { code?: string }).code === 'cursor_invalid',
  );
});

test('crawl path rejects out-of-range maxChars with invalid_request', async () => {
  await assert.rejects(
    callNativeTool('semantic_crawl', {
      source: { type: 'url', url: 'https://example.com/' },
      query: 'q',
      maxChars: 50001,
    }, { env: { ...NO_EMBEDDING } }),
    (err: unknown) => invalidRequestCode(err) === 'invalid_request',
  );
});

// ── Diffbot web_search backend (normal RRF, never primary) ──

function publicLookupStub() {
  return async () => [{ address: '93.184.216.34', family: 4 as const }];
}

test('web_search diffbot backend serves results with source diffbot', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://llm.diffbot.com/api/v1/web_search')) {
      return new Response(JSON.stringify({
        search_results: [
          { pageUrl: 'https://example.com/diffbot-a', title: 'Diffbot Alpha', content: 'diffbot snippet a' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'diffbot', DIFFBOT_TOKEN: 'test-token' },
    });
    const details = result.details as {
      results: Array<{ url: string; source: string }>;
      fusion: { backends: string[] };
    };
    assert.equal(details.results.length, 1);
    assert.equal(details.results[0]?.url, 'https://example.com/diffbot-a');
    assert.equal(details.results[0]?.source, 'diffbot');
    assert.ok(details.fusion.backends.includes('diffbot'));
  });
});

test('web_search diffbot participates in RRF without primary weighting', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://llm.diffbot.com/api/v1/web_search')) {
      return new Response(JSON.stringify({
        search_results: [
          { pageUrl: 'https://example.com/shared?utm_source=diffbot', title: 'Shared', content: 'shared snippet' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://api.duckduckgo.com/')) {
      return new Response(JSON.stringify({
        Heading: 'Shared',
        AbstractURL: 'https://www.example.com/shared',
        AbstractText: 'duck snippet',
        RelatedTopics: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'diffbot,duckduckgo', DIFFBOT_TOKEN: 'test-token' },
    });
    const details = result.details as {
      results: Array<{ url: string; rrfScore?: number }>;
      fusion: { backends: string[]; primary?: string };
    };
    assert.equal(details.results.length, 1);
    assert.ok((details.results[0]?.rrfScore ?? 0) > 0, 'diffbot+ddg duplicate must fuse with an rrfScore');
    assert.equal(details.fusion.primary, undefined, 'diffbot must never take primary weighting');
    assert.deepEqual(details.fusion.backends.sort(), ['diffbot', 'duckduckgo']);
  });
});

test('web_search explicit diffbot without token rejects as not configured', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }, async () => {
    await assert.rejects(
      () => callNativeTool('web_search', { query: 'example' }, { env: { PI_SEARCH_WEB_BACKENDS: 'diffbot' } }),
      /not configured/,
    );
  });
  assert.equal(calls, 0, 'unconfigured diffbot must not spawn any network call');
});

test('web_search diffbot never retries a non-retryable HTTP-200 error envelope (single paid call)', async () => {
  let diffbotCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://llm.diffbot.com/api/v1/web_search')) {
      diffbotCalls++;
      return new Response(JSON.stringify({ error: 'upstream request timeout', errorCode: 504 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    await assert.rejects(
      () => callNativeTool('web_search', { query: 'example', limit: 5 }, {
        env: { PI_SEARCH_WEB_BACKENDS: 'diffbot', DIFFBOT_TOKEN: 'test-token' },
      }),
      /All web search backends failed/,
    );
  });
  assert.equal(diffbotCalls, 1, 'non-retryable 200-envelope error must not trigger a second paid call');
});

test('web_search returns other providers when Diffbot rejects above operator cap (no paid call)', async () => {
  let diffbotCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://llm.diffbot.com/api/v1/web_search')) {
      diffbotCalls++;
      return new Response(JSON.stringify({ search_results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://api.duckduckgo.com/')) {
      return new Response(JSON.stringify({
        Heading: 'Example',
        AbstractURL: 'https://example.com/capped',
        AbstractText: 'duck result',
        RelatedTopics: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'diffbot,duckduckgo', DIFFBOT_TOKEN: 'test-token', DIFFBOT_SEARCH_SIZE: '3' },
    });
    const details = result.details as {
      results: Array<{ url: string; source: string }>;
      fusion: { backends: string[]; failures: Array<{ backend: string; error: string }> };
    };
    assert.equal(details.results.length, 1);
    assert.equal(details.results[0]?.url, 'https://example.com/capped');
    assert.deepEqual(details.fusion.backends, ['duckduckgo']);
    assert.ok(details.fusion.failures.some((f) => f.backend === 'diffbot' && /DIFFBOT_SEARCH_SIZE/.test(f.error)));
  });
  assert.equal(diffbotCalls, 0, 'operator-cap rejection must not trigger a paid Diffbot call');
});

// ── Diffbot Analyze-GET fetch fallback ──

function analyzeSuccessBody(url: string, text: string): unknown {
  return {
    objects: [{ title: 'Fallback Title', pageUrl: url, text, links: [] }],
  };
}

test('fetch falls back to Diffbot Analyze on native failure and marks execution fallback', async () => {
  let analyzeCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody('https://example.com/article', 'fallback content words '.repeat(40))), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('fetch failed');
  }, async () => {
    const result = await callNativeTool('semantic_crawl', {
      source: { type: 'url', url: 'https://example.com/article' },
      query: 'fallback content',
    }, {
      env: { ...NO_EMBEDDING, DIFFBOT_TOKEN: 'test-token' },
      lookup: publicLookupStub(),
    });
    const text = JSON.stringify(result);
    assert.match(text, /Fallback Title/, 'fallback page title must surface');
    const details = result.details as {
      fallback?: { provider: string; path: string; qualityImpact: string; pages: number };
      northstar?: { status: string };
    };
    assert.equal(details.fallback?.provider, 'diffbot');
    assert.equal(details.fallback?.path, 'fallback');
    assert.equal(details.fallback?.qualityImpact, 'not_assessed', 'degraded marks execution path, never content quality');
    assert.equal(details.fallback?.pages, 1);
    assert.equal(details.northstar?.status, 'degraded');
    assert.equal(analyzeCalls, 1);
  });
});

test('fetch never falls back on policy rejection (blocked hostname)', async () => {
  let analyzeCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody('https://example.com/x', 'should never be used')), { status: 200 });
    }
    throw new Error('fetch failed');
  }, async () => {
    await assert.rejects(
      () => callNativeTool('fetch', {
        url: 'http://localhost:3000/debug',
        query: 'fallback content',
        followLinks: true,
      }, {
        env: { ...NO_EMBEDDING, DIFFBOT_TOKEN: 'test-token' },
        lookup: publicLookupStub(),
      }),
      /Blocked hostname|Private\/reserved/,
    );
  });
  assert.equal(analyzeCalls, 0, 'policy rejection must never trigger paid fallback');
});

test('fetch never falls back on oversize response', async () => {
  let analyzeCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody('https://example.com/big', 'should never be used')), { status: 200 });
    }
    return new Response('x', { status: 200, headers: { 'content-length': '2000000', 'content-type': 'text/html' } });
  }, async () => {
    const result = await callNativeTool('fetch', {
      url: 'https://example.com/big',
      query: 'fallback content',
    }, {
      env: { ...NO_EMBEDDING, DIFFBOT_TOKEN: 'test-token' },
      lookup: publicLookupStub(),
    });
    const details = result.details as { fallback?: unknown };
    assert.equal(details.fallback, undefined, 'size failure must never trigger paid fallback');
  });
  assert.equal(analyzeCalls, 0, 'size failure must never trigger paid fallback');
});

test('fetch never falls back on caller abort', async () => {
  let analyzeCalls = 0;
  const controller = new AbortController();
  controller.abort();
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody('https://example.com/x', 'should never be used')), { status: 200 });
    }
    throw new Error('fetch failed');
  }, async () => {
    await assert.rejects(
      () => callNativeTool('agentic_browse', {
        action: 'read',
        url: 'https://example.com/article',
      }, {
        env: { ...NO_EMBEDDING, DIFFBOT_TOKEN: 'test-token' },
        lookup: publicLookupStub(),
        signal: controller.signal,
      }),
    );
  });
  assert.equal(analyzeCalls, 0, 'caller abort must never trigger paid fallback');
});

test('fetch shares one Analyze budget across pages (budget 1 = single fallback call)', async () => {
  let analyzeCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://llm.diffbot.com/api/v1/web_search')) throw new Error(`unexpected fetch ${url}`);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody('https://example.com/article', 'shared budget fallback words '.repeat(40))), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://api.duckduckgo.com/')) {
      return new Response(JSON.stringify({
        Heading: '',
        AbstractURL: '',
        AbstractText: '',
        RelatedTopics: [
          { Text: 'one - more', FirstURL: 'https://example.com/one' },
          { Text: 'two - more', FirstURL: 'https://example.com/two' },
          { Text: 'three - more', FirstURL: 'https://example.com/three' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('fetch failed');
  }, async () => {
    await callNativeTool('semantic_crawl', {
      source: { type: 'search', query: 'shared budget' },
      query: 'shared budget fallback',
      maxPages: 3,
    }, {
      env: { ...NO_EMBEDDING, DIFFBOT_TOKEN: 'test-token', DIFFBOT_FALLBACK_BUDGET: '1', PI_SEARCH_WEB_BACKENDS: 'duckduckgo' },
      lookup: publicLookupStub(),
    });
  });
  assert.equal(analyzeCalls, 1, 'one shared budget across the fetch must cap Analyze calls at 1');
});

test('fetch without token never calls Analyze (no behavior change)', async () => {
  let analyzeCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('api.diffbot.com')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody('https://example.com/x', 'should never be used')), { status: 200 });
    }
    throw new Error('fetch failed');
  }, async () => {
    await callNativeTool('fetch', {
      url: 'https://example.com/article',
      query: 'fallback content',
    }, {
      env: { ...NO_EMBEDDING },
      lookup: publicLookupStub(),
    });
  });
  assert.equal(analyzeCalls, 0, 'no token must mean no Analyze call');
});

test('fetchReadablePage without token falls through ineligible bridge errors to plain fetch', async () => {
  const bridge = { fetch: async () => { throw new Error('Scrapling response exceeded size limit'); } };
  await withFetch(async () => new Response('<html><head><title>Plain</title></head><body><p>plain fetch content words</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
    const page = await fetchReadablePage('https://example.com/article', undefined, bridge as never, publicLookupStub(), { env: {} });
    assert.match(page.content, /plain fetch content/);
    assert.equal(page.fallback, undefined);
  });
});

test('fetchReadablePage with token returns plain fetch after ineligible bridge failure without Analyze', async () => {
  let analyzeCalls = 0;
  const bridge = { fetch: async () => { throw new Error('Scrapling response exceeded size limit'); } };
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody(url, 'should never be used')), { status: 200 });
    }
    return new Response('<html><head><title>Plain</title></head><body><p>plain fetch content words</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }, async () => {
    const page = await fetchReadablePage('https://example.com/article', undefined, bridge as never, publicLookupStub(), { env: { DIFFBOT_TOKEN: 'test-token' } });
    assert.match(page.content, /plain fetch content/);
    assert.equal(page.fallback, undefined);
  });
  assert.equal(analyzeCalls, 0, 'ineligible bridge failure must not trigger Analyze when plain fetch succeeds');
});

test('fetchReadablePage with token throws original ineligible error when bridge and plain both fail', async () => {
  let analyzeCalls = 0;
  const bridge = { fetch: async () => { throw new Error('Scrapling response exceeded size limit'); } };
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody(url, 'should never be used')), { status: 200 });
    }
    throw new Error('plain fetch failed');
  }, async () => {
    await assert.rejects(
      () => fetchReadablePage('https://example.com/article', undefined, bridge as never, publicLookupStub(), { env: { DIFFBOT_TOKEN: 'test-token' } }),
      /exceeded size limit/,
    );
  });
  assert.equal(analyzeCalls, 0, 'blocked Analyze must never trigger a paid call');
});

test('fetchReadablePage without token surfaces plain error when bridge and plain both fail', async () => {
  const bridge = { fetch: async () => { throw new Error('Scrapling response exceeded size limit'); } };
  await withFetch(async () => { throw new Error('plain fetch failed'); }, async () => {
    await assert.rejects(
      () => fetchReadablePage('https://example.com/article', undefined, bridge as never, publicLookupStub(), { env: {} }),
      /plain fetch failed/,
    );
  });
});

test('fetchReadablePage without token returns empty bridge result without a second fetch', async () => {
  let plainFetches = 0;
  const bridge = { fetch: async () => ({ url: 'https://example.com/article', title: '', content: '   ' }) };
  await withFetch(async () => { plainFetches++; return new Response('unused', { status: 200 }); }, async () => {
    const page = await fetchReadablePage('https://example.com/article', undefined, bridge as never, publicLookupStub(), { env: {} });
    assert.equal(page.content, '');
  });
  assert.equal(plainFetches, 0, 'legacy no-token path must not issue a second fetch for empty bridge content');
});
