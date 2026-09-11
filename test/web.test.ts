import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import { fetchReadablePage, fuseWebSearchRankings } from '../src/web.js';

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

/** DuckDuckGo single-HTML-call fixture: result__a href + result__snippet pairs. */
function ddgHtmlResponse(entries: Array<{ title: string; url: string; snippet: string }>): Response {
  const body = entries.map((entry) =>
    `<div><a class="result__a" href="${entry.url}">${entry.title}</a>` +
    `<a class="result__snippet" href="${entry.url}">${entry.snippet}</a></div>`,
  ).join('');
  return new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
}

// ── web_search backend behavior (moved from native-tools.test.ts) ──

test('native web_search fans out configured backends and fuses duplicate URLs with RRF', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'Example', url: 'https://example.com/page?utm_source=ddg', snippet: 'Duck result' }]);
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
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'H', url: 'https://example.com/x', snippet: 't' }]);
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
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([
        { title: 'First hit', url: 'https://example.com/a', snippet: 'First snippet' },
        { title: 'Second hit', url: 'https://example.com/b', snippet: 'Second snippet' },
      ]);
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
  const body = `<html><head><title>Long page</title></head><body><p>${'alpha beta gamma delta content words '.repeat(1000)}</p></body></html>`;
  const { server, baseUrl } = await startServer({ '/': body });
  try {
    const result = await callNativeTool('agentic_browse', { action: 'read', url: baseUrl + '/' }, { fetchPageText: localFetchText });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.ok(text.length <= 30000, `default maxChars bounds read text, got ${text.length}`);
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
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'Shared', url: 'https://www.example.com/shared', snippet: 'duck snippet' }]);
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
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'Example', url: 'https://example.com/capped', snippet: 'duck result' }]);
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
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([
        { title: 'one', url: 'https://example.com/one', snippet: 'one snippet' },
        { title: 'two', url: 'https://example.com/two', snippet: 'two snippet' },
        { title: 'three', url: 'https://example.com/three', snippet: 'three snippet' },
      ]);
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

// ── Bounded selection + uniform RRF (approved web-search runtime) ──

test('default allowlist selects exactly the first three configured providers', async () => {
  const calls: string[] = [];
  await withFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://api.tavily.com/search')) {
      return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://example.com/t', content: 'tavily body' }] }), { status: 200 });
    }
    if (url.startsWith('https://api.exa.ai/search')) {
      return new Response(JSON.stringify({ results: [{ title: 'E', url: 'https://example.com/e', text: 'exa body' }] }), { status: 200 });
    }
    if (url.startsWith('https://api.search.brave.com/')) {
      return new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://example.com/b', description: 'brave body' }] } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { TAVILY_API_KEY: 't', EXA_API_KEY: 'e', BRAVE_API_KEY: 'b' },
    });
    const details = result.details as {
      results: Array<{ url: string }>;
      fusion: { selected: string[]; runnable: string[]; unavailable: string[]; backends: string[] };
    };
    assert.deepEqual(details.fusion.selected, ['tavily', 'exa', 'brave']);
    assert.deepEqual(details.fusion.runnable, ['tavily', 'exa', 'brave']);
    assert.deepEqual(details.fusion.unavailable, []);
    assert.deepEqual(details.fusion.backends.sort(), ['brave', 'exa', 'tavily']);
    assert.equal(details.results.length, 3);
    assert.ok(calls.every((url) => !url.includes('duckduckgo')), 'unselected duckduckgo must not be called');
  });
});

test('explicit eight backends dispatch exactly eight calls concurrently', async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  await withFetch(async (input) => {
    const url = String(input);
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    if (url.startsWith('https://api.tavily.com/search')) {
      return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://example.com/t', content: 't' }] }), { status: 200 });
    }
    if (url.startsWith('https://api.exa.ai/search')) {
      return new Response(JSON.stringify({ results: [{ title: 'E', url: 'https://example.com/e', text: 'e' }] }), { status: 200 });
    }
    if (url.startsWith('https://api.search.brave.com/')) {
      return new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://example.com/b', description: 'b' }] } }), { status: 200 });
    }
    if (url.startsWith('https://llm.diffbot.com/api/v1/web_search')) {
      return new Response(JSON.stringify({ search_results: [{ pageUrl: 'https://example.com/d', title: 'D', content: 'd' }] }), { status: 200 });
    }
    if (url.startsWith('https://api.firecrawl.dev/v2/search')) {
      return new Response(JSON.stringify({ success: true, data: { web: [{ url: 'https://example.com/f', title: 'F', description: 'f' }] } }), { status: 200 });
    }
    if (url.startsWith('https://s.jina.ai/')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://example.com/j', title: 'J', description: 'j' }] }), { status: 200 });
    }
    if (url.startsWith('https://searxng.example/search')) {
      return new Response(JSON.stringify({ results: [{ title: 'S', url: 'https://example.com/s', content: 's' }] }), { status: 200 });
    }
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'G', url: 'https://example.com/g', snippet: 'g' }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const order = 'tavily,exa,brave,diffbot,firecrawl,jina,searxng,duckduckgo';
    const result = await callNativeTool('web_search', { query: 'example', limit: 8 }, {
      env: {
        PI_SEARCH_WEB_BACKENDS: order,
        TAVILY_API_KEY: 't', EXA_API_KEY: 'e', BRAVE_API_KEY: 'b', DIFFBOT_TOKEN: 'd',
        FIRECRAWL_API_KEY: 'f', JINA_API_KEY: 'j', SEARXNG_BASE_URL: 'https://searxng.example',
      },
    });
    const details = result.details as {
      results: Array<{ url: string }>;
      fusion: { selected: string[]; runnable: string[]; backends: string[] };
    };
    assert.equal(calls, 8, 'exactly eight provider calls, no more');
    assert.ok(maxInFlight > 1, `providers run concurrently, got max in-flight ${maxInFlight}`);
    assert.deepEqual(details.fusion.selected, order.split(','));
    assert.equal(details.results.length, 8);
    assert.deepEqual(details.fusion.backends.sort(), order.split(',').sort());
  });
});

test('duplicate and ninth explicit backends reject before any provider call', async () => {
  for (const backends of [
    'brave,brave',
    'tavily,exa,brave,diffbot,firecrawl,jina,searxng,duckduckgo,codex',
  ]) {
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }, async () => {
      await assert.rejects(
        () => callNativeTool('web_search', { query: 'example' }, { env: { PI_SEARCH_WEB_BACKENDS: backends, BRAVE_API_KEY: 'b' } }),
        backends.includes('brave,brave') ? /duplicate/ : /at most 8/,
      );
    });
    assert.equal(calls, 0, `${backends} must not spawn any provider call`);
  }
});

test('explicit unavailable provider records unavailable without replenishment', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.search.brave.com/')) {
      return new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://example.com/b', description: 'b' }] } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'brave,exa', BRAVE_API_KEY: 'b' },
    });
    const details = result.details as {
      results: Array<{ url: string }>;
      fusion: { selected: string[]; runnable: string[]; unavailable: string[]; backends: string[] };
    };
    assert.deepEqual(details.fusion.selected, ['brave', 'exa']);
    assert.deepEqual(details.fusion.runnable, ['brave']);
    assert.deepEqual(details.fusion.unavailable, ['exa']);
    assert.deepEqual(details.fusion.backends, ['brave']);
    assert.equal(details.results.length, 1);
  });
});

test('codex participates in uniform RRF with no primary weighting', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://chatgpt.com/backend-api/codex/alpha/search')) {
      return new Response(JSON.stringify({ results: [
        { url: 'https://example.com/shared?utm_source=codex', title: 'Shared', snippet: 'codex snippet' },
        { url: 'https://example.com/codex-only', title: 'Codex only', snippet: 'c' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([
        { title: 'Shared', url: 'https://www.example.com/shared', snippet: 'duck snippet' },
        { title: 'DDG only', url: 'https://example.com/ddg-only', snippet: 'd' },
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'codex,duckduckgo', CODEX_ACCESS_TOKEN: 'tok' },
    });
    const details = result.details as {
      results: Array<{ url: string; rrfScore?: number; contributors?: Array<{ backend: string; rank: number }> }>;
      fusion: { backends: string[]; primary?: string };
    };
    assert.equal(details.results.length, 3);
    assert.equal(details.fusion.primary, undefined, 'no provider takes primary weighting');
    assert.deepEqual(details.fusion.backends.sort(), ['codex', 'duckduckgo']);
    const first = details.results[0]!;
    assert.equal(first.contributors?.length, 2, 'shared URL records both contributors');
    assert.ok((first.rrfScore ?? 0) > 0.03, 'shared URL outranks singletons by uniform RRF');
  });
});

test('uniform fusion surfaces richest donor without moving RRF score or order', () => {
  const fused = fuseWebSearchRankings([
    { backend: 'exa', hits: [{ title: 'Exa shared', url: 'https://example.com/shared', snippet: 'short', backend: 'exa' }] },
    { backend: 'brave', hits: [{ title: 'Brave shared', url: 'https://www.example.com/shared', snippet: 'a richer snippet body', backend: 'brave' }] },
  ], 8);
  assert.equal(fused.length, 1);
  assert.equal(fused[0]?.snippet, 'a richer snippet body');
  assert.equal(fused[0]?.backend, 'brave');
  assert.deepEqual(fused[0]?.contributors, [{ backend: 'exa', rank: 1 }, { backend: 'brave', rank: 1 }]);
  const expectedScore = 1 / (60 + 1) + 1 / (60 + 1);
  assert.equal(fused[0]?.rrfScore, expectedScore);

  const kinded = fuseWebSearchRankings([
    { backend: 'exa', hits: [{ title: 'Exa shared', url: 'https://example.com/shared', snippet: 'a much longer snippet body', backend: 'exa' }] },
    { backend: 'brave', hits: [{ title: 'Brave shared', url: 'https://www.example.com/shared', snippet: 'x', contentKind: 'summary', backend: 'brave' }] },
  ], 8);
  assert.equal(kinded[0]?.backend, 'brave');
  assert.equal(kinded[0]?.rrfScore, expectedScore);

  const tied = fuseWebSearchRankings([
    { backend: 'exa', hits: [{ title: 'Exa shared', url: 'https://example.com/shared', snippet: 'same', backend: 'exa' }] },
    { backend: 'brave', hits: [{ title: 'Brave shared', url: 'https://www.example.com/shared', snippet: 'same', backend: 'brave' }] },
  ], 8);
  assert.equal(tied[0]?.backend, 'exa', 'exact richness ties keep the earlier selected provider');
  assert.deepEqual(tied[0]?.contributors, [{ backend: 'exa', rank: 1 }, { backend: 'brave', rank: 1 }]);

  const orderTied = fuseWebSearchRankings([
    { backend: 'brave', hits: [{ title: 'B', url: 'https://example.com/b', snippet: 'b', backend: 'brave' }] },
    { backend: 'exa', hits: [{ title: 'A', url: 'https://example.com/a', snippet: 'a', backend: 'exa' }] },
  ], 8);
  assert.deepEqual(orderTied.map((hit) => hit.backend), ['brave', 'exa'], 'equal RRF scores follow selected-provider order');
});

test('fusion preserves backfilled publication metadata on the richest donor', () => {
  const fused = fuseWebSearchRankings([
    { backend: 'exa', hits: [{ title: 'Exa shared', url: 'https://example.com/shared', snippet: 'a richer snippet body', backend: 'exa' }] },
    { backend: 'brave', hits: [{ title: 'Brave shared', url: 'https://www.example.com/shared', snippet: 'x', backend: 'brave', publishedDate: '2026-01-01', author: 'Ada' }] },
  ], 8);
  assert.equal(fused[0]?.backend, 'exa');
  assert.equal(fused[0]?.publishedDate, '2026-01-01');
  assert.equal(fused[0]?.author, 'Ada');
});

test('failed providers are never retried: 429 and 5xx cost one call each', async () => {
  for (const status of [429, 500]) {
    let calls = 0;
    await withFetch(async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.search.brave.com/')) {
        calls++;
        return new Response('error', { status });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      await assert.rejects(
        () => callNativeTool('web_search', { query: 'example' }, { env: { PI_SEARCH_WEB_BACKENDS: 'brave', BRAVE_API_KEY: 'b' } }),
        /All web search backends failed/,
      );
    });
    assert.equal(calls, 1, `HTTP ${status} must not be retried`);
  }
});

test('caller abort cancels every active request instead of a failure envelope', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await withFetch(async (_input, init) => {
    calls++;
    if ((init?.signal as AbortSignal | undefined)?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    return ddgHtmlResponse([{ title: 'X', url: 'https://example.com/x', snippet: 'x' }]);
  }, async () => {
    await assert.rejects(
      () => callNativeTool('web_search', { query: 'example' }, {
        env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo,brave', BRAVE_API_KEY: 'b' },
        signal: controller.signal,
      }),
      (err: unknown) => (err as { name?: string }).name === 'AbortError',
    );
  });
  assert.equal(calls, 2, 'both providers dispatch, then abort wins');
});

test('partial provider failure retains surviving results with failure detail', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.tavily.com/search')) {
      return new Response('error', { status: 500 });
    }
    if (url.startsWith('https://api.search.brave.com/')) {
      return new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://example.com/b', description: 'b' }] } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'tavily,brave', TAVILY_API_KEY: 't', BRAVE_API_KEY: 'b' },
    });
    const details = result.details as {
      results: Array<{ url: string }>;
      fusion: { backends: string[]; failures: Array<{ backend: string; error: string }> };
    };
    assert.equal(details.results.length, 1);
    assert.deepEqual(details.fusion.backends, ['brave']);
    assert.equal(details.fusion.failures.length, 1);
    assert.equal(details.fusion.failures[0]?.backend, 'tavily');
  });
});

test('provider-native summaries and answers stay separate from retrieval snippets', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.exa.ai/search')) {
      return new Response(JSON.stringify({ results: [{
        title: 'E', url: 'https://example.com/e', text: 'original body', highlights: ['highlight excerpt'], summary: 'AI SUMMARY TEXT',
      }] }), { status: 200 });
    }
    if (url.startsWith('https://api.tavily.com/search')) {
      return new Response(JSON.stringify({
        answer: 'TAVILY ANSWER TEXT',
        results: [{ title: 'T', url: 'https://example.com/t', content: 'tavily body' }],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'exa,tavily', EXA_API_KEY: 'e', TAVILY_API_KEY: 't' },
    });
    const details = result.details as {
      results: Array<{ url: string; snippet: string }>;
      nativeAi: Array<{ kind: string; backend: string; url?: string; text: string; provenance: { kind: string; urls: string[] }; claimCitations: boolean }>;
    };
    const exaHit = details.results.find((hit) => hit.url === 'https://example.com/e')!;
    assert.match(exaHit.snippet, /highlight excerpt/);
    assert.doesNotMatch(JSON.stringify(details.results), /AI SUMMARY TEXT/);
    assert.doesNotMatch(JSON.stringify(details.results), /TAVILY ANSWER TEXT/);
    const summary = details.nativeAi.find((item) => item.kind === 'summary')!;
    assert.equal(summary.backend, 'exa');
    assert.deepEqual(summary.provenance, { kind: 'result_url', urls: ['https://example.com/e'] });
    assert.equal(summary.claimCitations, false);
    const answer = details.nativeAi.find((item) => item.kind === 'answer')!;
    assert.equal(answer.backend, 'tavily');
    assert.equal(answer.provenance.kind, 'supporting_result_set');
    assert.ok(answer.provenance.urls.includes('https://example.com/t'));
    assert.equal(answer.claimCitations, false);
    assert.doesNotMatch(JSON.stringify(result), /backend_text/);
  });
});

test('semantic discovery uses identical selection rules', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }, async () => {
    await assert.rejects(
      () => callNativeTool('semantic_crawl', {
        source: { type: 'search', query: 'discovery words' },
        query: 'discovery words',
      }, { env: { ...NO_EMBEDDING, PI_SEARCH_WEB_BACKENDS: 'bogus' } }),
      /Unknown web search backends/,
    );
  });
  assert.equal(calls, 0, 'unknown backend must not spawn discovery calls');

  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'Seed', url: 'https://example.com/seed', snippet: 'seed snippet' }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('semantic_crawl', {
      source: { type: 'search', query: 'seed content words' },
      query: 'seed content words',
    }, {
      fetchPageText: async () => '<html><head><title>Seed</title></head><body><p>seed content words for discovery testing. ' + 'Additional descriptive sentences about the seed page keep the chunk above the minimum size. '.repeat(10) + '</p></body></html>',
      env: { ...NO_EMBEDDING, PI_SEARCH_WEB_BACKENDS: 'duckduckgo' },
    });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.match(text, /seed content words for discovery testing/);
  });
});

test('research-category web_search invokes zero generic providers', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'attention', category: 'research', limit: 5 }, { env: {} });
    const details = result.details as {
      results: unknown[];
      northstar: { data: { kind: string; entities: unknown[] } };
    };
    assert.equal(details.results.length, 0);
    assert.equal(details.northstar.data.kind, 'entities');
    assert.equal(details.northstar.data.entities.length, 0);
  });
  assert.equal(calls, 0, 'research category must not call generic providers');
});

// ── Optional knowledge composition (dual-gated, Diffbot-bound) ──

test('knowledge request without enrichment gate makes zero Diffbot calls', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('diffbot.com')) throw new Error(`unexpected diffbot call ${url}`);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'K', url: 'https://example.com/k', snippet: 'knowledge snippet' }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 3, knowledge: { entities: true } }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo', DIFFBOT_TOKEN: 'test-token' },
    });
    const details = result.details as { knowledge?: unknown };
    assert.equal(details.knowledge, undefined);
  });
});

test('knowledge composes safe excerpts and skips suspected sensitive text without echo', async () => {
  const analyzedBodies: string[] = [];
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([
        { title: 'Clean', url: 'https://example.com/clean', snippet: 'public launch announcement details' },
        { title: 'Contact', url: 'https://example.com/contact', snippet: 'reach us at bob@example.com today' },
      ]);
    }
    if (url.includes('nl.diffbot.com')) {
      analyzedBodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify([{ entities: [], facts: [], topics: [] }]), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5, knowledge: { entities: true } }, {
      env: {
        PI_SEARCH_WEB_BACKENDS: 'duckduckgo',
        DIFFBOT_TOKEN: 'test-token',
        PI_SEARCH_KG_ENRICHMENT: '1',
      },
    });
    const details = result.details as {
      knowledge: { status: string; skipped: Array<{ url: string; reason: string }> };
    };
    assert.equal(analyzedBodies.length, 1, 'only the safe excerpt is analyzed');
    assert.match(analyzedBodies[0]!, /public launch announcement/);
    assert.doesNotMatch(analyzedBodies[0]!, /bob@example\.com/);
    assert.equal(details.knowledge.status, 'empty');
    assert.ok(details.knowledge.skipped.some((entry) =>
      entry.url === 'https://example.com/contact' && entry.reason === 'suspected_sensitive_or_personal',
    ));
  });
});

test('knowledge without token reports unavailable without vendor calls', async () => {
  let vendorCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('diffbot.com')) {
      vendorCalls++;
      throw new Error(`unexpected diffbot call ${url}`);
    }
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return ddgHtmlResponse([{ title: 'K', url: 'https://example.com/k', snippet: 'knowledge snippet' }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'example', limit: 3, knowledge: { enhance: true } }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo', PI_SEARCH_KG_ENRICHMENT: '1' },
    });
    const details = result.details as { knowledge: { status: string } };
    assert.equal(details.knowledge.status, 'unavailable');
  });
  assert.equal(vendorCalls, 0);
});

// ── Ordered external fetch fallback (gated, after native/Diffbot) ──

test('fetch falls through to gated Firecrawl with separate summary and metadata', async () => {
  let scrapeBody: Record<string, unknown> | undefined;
  let analyzeCalls = 0;
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response('analyze down', { status: 500 });
    }
    if (url.startsWith('https://api.firecrawl.dev/v2/scrape')) {
      scrapeBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown: 'external content words from vendor',
          summary: 'VENDOR SUMMARY TEXT',
          metadata: { title: 'External Title' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('native fetch failed');
  }, async () => {
    const page = await fetchReadablePage('https://example.com/article', undefined, undefined, publicLookupStub(), {
      env: {
        DIFFBOT_TOKEN: 'test-token',
        PI_SEARCH_EXTERNAL_FETCH: '1',
        PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
        FIRECRAWL_API_KEY: 'firecrawl-key',
      },
    });
    assert.match(page.content, /external content words from vendor/);
    assert.doesNotMatch(page.content, /VENDOR SUMMARY TEXT/);
    assert.equal(page.externalFetch?.backend, 'firecrawl');
    assert.equal(page.externalFetch?.externalProcessing, true);
    assert.equal(page.title, 'External Title');
    assert.equal(page.generatedText?.length, 1);
    assert.match(page.generatedText?.[0]?.text ?? '', /VENDOR SUMMARY TEXT/);
    assert.equal(page.generatedText?.[0]?.provenance.kind, 'result_url');
    assert.equal(analyzeCalls, 1, 'Diffbot Analyze still precedes external fetch');
    const formats = scrapeBody?.formats as unknown[];
    assert.ok(formats.includes('markdown'));
    assert.ok(formats.some((format) => typeof format === 'object' && (format as { type?: string }).type === 'summary'));
    assert.doesNotMatch(JSON.stringify(scrapeBody), /question/);
  });
});

test('Firecrawl fetch honors PI_SEARCH_NATIVE_SUMMARIES=0 with markdown only', async () => {
  let scrapeBody: Record<string, unknown> | undefined;
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      return new Response('analyze down', { status: 500 });
    }
    if (url.startsWith('https://api.firecrawl.dev/v2/scrape')) {
      scrapeBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({
        success: true,
        data: { markdown: 'plain external words', metadata: { title: 'T' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('native fetch failed');
  }, async () => {
    const page = await fetchReadablePage('https://example.com/article', undefined, undefined, publicLookupStub(), {
      env: {
        DIFFBOT_TOKEN: 'test-token',
        PI_SEARCH_EXTERNAL_FETCH: '1',
        PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
        FIRECRAWL_API_KEY: 'firecrawl-key',
        PI_SEARCH_NATIVE_SUMMARIES: '0',
      },
    });
    assert.match(page.content, /plain external words/);
    assert.deepEqual(scrapeBody?.formats, ['markdown']);
    assert.equal(page.generatedText, undefined);
  });
});

test('external fetch never triggers on ineligible 404 failure', async () => {
  let firecrawlCalls = 0;
  let analyzeCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response('analyze down', { status: 500 });
    }
    if (url.startsWith('https://api.firecrawl.dev/v2/scrape')) {
      firecrawlCalls++;
      return new Response('{}', { status: 200 });
    }
    throw new Error('HTTP 404 for https://example.com/missing');
  }, async () => {
    await assert.rejects(
      () => fetchReadablePage('https://example.com/missing', undefined, undefined, publicLookupStub(), {
        env: {
          DIFFBOT_TOKEN: 'test-token',
          PI_SEARCH_EXTERNAL_FETCH: '1',
          PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
          FIRECRAWL_API_KEY: 'firecrawl-key',
        },
      }),
      /404/,
    );
  });
  assert.equal(firecrawlCalls, 0, 'ineligible 404 must never reach remote vendors');
  assert.equal(analyzeCalls, 1, 'diffbot Analyze fallback runs fail-open on 404; only gated external fetch is 404-ineligible');
});

test('external fetch runs without DIFFBOT_TOKEN on eligible native failure', async () => {
  let firecrawlCalls = 0;
  let analyzeCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      analyzeCalls++;
      return new Response(JSON.stringify(analyzeSuccessBody(url, 'should never be used')), { status: 200 });
    }
    if (url.startsWith('https://api.firecrawl.dev/v2/scrape')) {
      firecrawlCalls++;
      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown: 'no-token external content words',
          summary: 'NO-TOKEN VENDOR SUMMARY',
          metadata: { title: 'No-Token Title' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('HTTP 500 for https://example.com/article');
  }, async () => {
    const page = await fetchReadablePage('https://example.com/article', undefined, undefined, publicLookupStub(), {
      env: {
        PI_SEARCH_EXTERNAL_FETCH: '1',
        PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
        FIRECRAWL_API_KEY: 'firecrawl-key',
      },
    });
    assert.match(page.content, /no-token external content words/);
    assert.doesNotMatch(page.content, /NO-TOKEN VENDOR SUMMARY/);
    assert.equal(page.externalFetch?.backend, 'firecrawl');
    assert.equal(page.externalFetch?.externalProcessing, true);
    assert.equal(page.fallback, undefined, 'no Diffbot token means no diffbot fallback marker');
    assert.equal(page.generatedText?.length, 1);
  });
  assert.equal(firecrawlCalls, 1, 'eligible no-token failure must reach the gated vendor');
  assert.equal(analyzeCalls, 0, 'no token must mean no Analyze call');
});

test('external fetch without token never triggers on ineligible 404 failure', async () => {
  let firecrawlCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.firecrawl.dev/v2/scrape')) {
      firecrawlCalls++;
      return new Response('{}', { status: 200 });
    }
    throw new Error('HTTP 404 for https://example.com/missing');
  }, async () => {
    await assert.rejects(
      () => fetchReadablePage('https://example.com/missing', undefined, undefined, publicLookupStub(), {
        env: {
          PI_SEARCH_EXTERNAL_FETCH: '1',
          PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
          FIRECRAWL_API_KEY: 'firecrawl-key',
        },
      }),
      /404/,
    );
  });
  assert.equal(firecrawlCalls, 0, 'ineligible 404 must never reach remote vendors without a token either');
});

test('native web_search agent mode returns report text with details.report, no fusion', async () => {
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url === 'https://api.tavily.com/research' && init?.method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(body, { input: 'deep topic', model: 'pro', stream: true });
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of [
            'data: {"choices": [{"delta": {"content": "Agent report "}}]}\n\n',
            'data: {"choices": [{"delta": {"content": "body", "sources": [{"url": "https://a.example/x", "title": "A"}, {"url": "https://b.example/y", "title": "B"}]}}]}\n\n',
            'event: done\ndata: {}\n\n',
          ]) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('web_search', { query: 'deep topic', mode: 'agent' }, { env: { TAVILY_API_KEY: 'k', ...NO_EMBEDDING } });
    const text = (result.content as Array<{ text?: string }>).map((c: { text?: string }) => c.text ?? '').join('');
    assert.ok(text.includes('Agent report body'));
    const details = result.details as Record<string, unknown>;
    const report = details.report as { status: string; provider: string; sources: Array<{ url: string; title: string }> };
    assert.equal(report.status, 'ok');
    assert.equal(report.provider, 'tavily');
    assert.equal(report.sources.length, 2);
    assert.ok(!('fusion' in details));
    assert.ok(!('nativeAi' in details));
    assert.ok(!('knowledge' in details));
  });
});

test('native web_search agent mode rejects knowledge and research category before fetch', async () => {
  let fetched = false;
  await withFetch(async () => {
    fetched = true;
    return new Response('{}', { status: 200 });
  }, async () => {
    await assert.rejects(() => callNativeTool('web_search', { query: 'q', mode: 'agent', knowledge: { entities: true } }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('web_search', { query: 'q', mode: 'agent', category: 'research' }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('web_search', { query: 'q', mode: 'bogus' }, { env: { TAVILY_API_KEY: 'k' } }));
  });
  assert.equal(fetched, false);
});

test('native web_search agent mode unconfigured provider errors', async () => {
  await assert.rejects(() => callNativeTool('web_search', { query: 'q', mode: 'agent' }, { env: { ...NO_EMBEDDING } }), /No report-capable/);
});

test('native fetch siteMap returns ordered URL list with details.siteMap', async () => {
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url === 'https://api.tavily.com/map' && init?.method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.allow_external, false);
      assert.equal(body.limit, 10);
      return new Response(JSON.stringify({
        base_url: 'https://docs.example.com',
        results: ['https://docs.example.com/b', 'https://docs.example.com/a'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true }, { env: { TAVILY_API_KEY: 'k', ...NO_EMBEDDING }, lookup: publicLookupStub() });
    const text = (result.content as Array<{ text?: string }>).map((c: { text?: string }) => c.text ?? '').join('');
    assert.ok(text.includes('1. https://docs.example.com/b'));
    assert.ok(text.includes('2. https://docs.example.com/a'));
    const details = result.details as Record<string, unknown>;
    const siteMap = details.siteMap as { status: string; provider: string; baseUrl: string; urls: string[]; ranking: string };
    assert.equal(siteMap.status, 'ok');
    assert.equal(siteMap.provider, 'tavily');
    assert.equal(siteMap.baseUrl, 'https://docs.example.com');
    assert.deepEqual(siteMap.urls, ['https://docs.example.com/b', 'https://docs.example.com/a']);
    assert.equal(siteMap.ranking, 'provider');
  });
});

test('native fetch siteMap empty map yields empty status', async () => {
  await withFetch(async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }), async () => {
    const result = await callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true }, { env: { TAVILY_API_KEY: 'k', ...NO_EMBEDDING }, lookup: publicLookupStub() });
    const siteMap = (result.details as Record<string, unknown>).siteMap as { status: string; urls: string[] };
    assert.equal(siteMap.status, 'empty');
    assert.deepEqual(siteMap.urls, []);
  });
});

test('native fetch siteMap rejects combos and non-boolean before fetch', async () => {
  let fetched = false;
  await withFetch(async () => {
    fetched = true;
    return new Response('{}', { status: 200 });
  }, async () => {
    await assert.rejects(() => callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true, searchQuery: 'x' }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true, followLinks: true, query: 'x' }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true, topK: 5 }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true, maxChars: 500 }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: 'yes' }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('fetch', { siteMap: true }, { env: { TAVILY_API_KEY: 'k' } }));
    await assert.rejects(() => callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true, maxPages: '5' }, { env: { TAVILY_API_KEY: 'k' } }), /maxPages/);
  });
  assert.equal(fetched, false);
});

test('native fetch siteMap unconfigured provider errors', async () => {
  await assert.rejects(() => callNativeTool('fetch', { url: 'https://docs.example.com/', siteMap: true }, { env: { ...NO_EMBEDDING } }), /No sitemap-capable/);
});

// ── Visible truncation: marker + counts inside maxChars, no mid-word cut ──

test('read path truncation carries a visible marker with counts inside maxChars', async () => {
  const body = `<html><head><title>Long page</title></head><body><p>${'alpha beta gamma delta content words '.repeat(50)}</p></body></html>`;
  const result = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/long', maxChars: 500 }, {
    fetchPageText: async () => body,
  });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  assert.ok(text.length <= 500, `truncated text must fit maxChars, got ${text.length}`);
  assert.match(text, /\[truncated: showing \d+ of \d+ chars; raise maxChars up to 50000 for more\]/);
  assert.doesNotMatch(text.slice(0, text.indexOf('[truncated')), /[A-Za-z]$/);
  const details = result.details as { truncated?: boolean; maxChars?: number; omittedChars?: number; content?: string };
  assert.equal(details.truncated, true);
  assert.equal(details.maxChars, 500);
  assert.ok((details.omittedChars ?? 0) > 0, 'omitted count must be positive');
  assert.equal(details.content, text);
});

test('read path without truncation carries no marker', async () => {
  const body = '<html><head><title>Short</title></head><body><p>short page words</p></body></html>';
  const result = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/short' }, {
    fetchPageText: async () => body,
  });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  assert.doesNotMatch(text, /\[truncated:/);
  assert.equal((result.details as { truncated?: boolean }).truncated, false);
});

test('crawl path truncation carries a visible marker with counts inside maxChars', async () => {
  const body = `<html><head><title>Crawl page</title></head><body><p>${'crawl target words '.repeat(50)}</p></body></html>`;
  const result = await callNativeTool('semantic_crawl', {
    source: { type: 'url', url: 'https://example.com/crawl' },
    query: 'crawl target',
    maxChars: 500,
  }, { fetchPageText: async () => body, env: { ...NO_EMBEDDING } });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  assert.ok(text.length <= 500, `truncated text must fit maxChars, got ${text.length}`);
  assert.match(text, /\[truncated: showing \d+ of \d+ chars; raise maxChars up to 50000 for more\]/);
  const details = result.details as { truncated?: boolean; maxChars?: number; omittedChars?: number };
  assert.equal(details.truncated, true);
  assert.equal(details.maxChars, 500);
  assert.ok((details.omittedChars ?? 0) > 0, 'omitted count must be positive');
});

test('read path truncation ends at a complete sentence', async () => {
  const body = `<html><head><title>Sentences</title></head><body><p>${'First claim holds true. Second claim adds evidence. '.repeat(30)}</p></body></html>`;
  const result = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/sentences', maxChars: 500 }, {
    fetchPageText: async () => body,
  });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  assert.ok(text.length <= 500, `truncated text must fit maxChars, got ${text.length}`);
  assert.match(text, /\[truncated: showing \d+ of \d+ chars; raise maxChars up to 50000 for more\]/);
  assert.match(text.slice(0, text.indexOf('[truncated')).trimEnd().slice(-1), /[.!?…]/);
});

test('read path drops navigation chrome from the evidence budget', async () => {
  const body = `<html><head><title>Nav page</title></head><body><nav>Home | About | Contact | Privacy</nav><p>${'Article substance words follow. '.repeat(40)}</p></body></html>`;
  const result = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/nav', maxChars: 500 }, {
    fetchPageText: async () => body,
  });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  assert.ok(text.length <= 500, `truncated text must fit maxChars, got ${text.length}`);
  assert.doesNotMatch(text, /Contact/);
  assert.match(text, /Article substance/);
});

test('read path keeps unsafe link targets inert', async () => {
  const body = '<html><head><title>Links</title></head><body><p>Read <a href="javascript:alert(1)">click here</a> for detail.</p></body></html>';
  const result = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/links' }, {
    fetchPageText: async () => body,
  });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  assert.doesNotMatch(text, /javascript:/);
  assert.match(text, /click here/);
});
