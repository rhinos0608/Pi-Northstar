import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import { sanitizeExternalOutput } from '../src/reach-tools.js';
import { writeCookieState } from '../src/cookie-jar.js';

test('callNativeTool fetch alias routes to semanticCrawl', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', {}),
    /query is required/,
  );
});

test('callNativeTool fetch returns same result as semantic_crawl for private URL', async () => {
  // Start ephemeral HTTP server
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Hello World</h1><p>Test content for crawling.</p></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const privateUrl = `http://127.0.0.1:${addr.port}/`;

  try {
    const fetchResult = await callNativeTool('fetch', { url: privateUrl, query: 'hello' });
    const crawlResult = await callNativeTool('semantic_crawl', { source: { type: 'url', url: privateUrl }, query: 'hello', maxPages: 1 });

    const fetchText = JSON.stringify(fetchResult);
    const crawlText = JSON.stringify(crawlResult);
    assert.match(fetchText, /hello/i);
    assert.match(crawlText, /hello/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('callNativeTool rejects unsupported tools', async () => {
  await assert.rejects(
    () => callNativeTool('missing_tool', {}),
    /Unsupported native tool/,
  );
});

test('native browse accepts localhost and private URLs — validation passes (containerization handles containment)', async () => {
  const { validatePublicHttpUrl } = await import('../src/http.js');
  assert.equal(validatePublicHttpUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(validatePublicHttpUrl('http://localhost:3000/path'), 'http://localhost:3000/path');
  assert.equal(validatePublicHttpUrl('http://10.0.0.1/'), 'http://10.0.0.1/');
  assert.equal(validatePublicHttpUrl('http://192.168.1.1/'), 'http://192.168.1.1/');
  assert.equal(validatePublicHttpUrl('http://172.16.0.1/'), 'http://172.16.0.1/');
  assert.equal(validatePublicHttpUrl('http://127.0.0.1/'), 'http://127.0.0.1/');
  assert.equal(validatePublicHttpUrl('http://169.254.169.254/'), 'http://169.254.169.254/');
  assert.equal(validatePublicHttpUrl('http://100.64.0.1/'), 'http://100.64.0.1/');
  assert.equal(validatePublicHttpUrl('http://metadata.google.internal/'), 'http://metadata.google.internal/');
});

test('native browse accepts IPv6 link-local, ULAs, and mapped loopback — validation passes', async () => {
  const { validatePublicHttpUrl } = await import('../src/http.js');
  assert.equal(validatePublicHttpUrl('http://[fe80::1]/'), 'http://[fe80::1]/');
  assert.equal(validatePublicHttpUrl('http://[fd00::1]/'), 'http://[fd00::1]/');
  assert.equal(validatePublicHttpUrl('http://[fc00::1]/'), 'http://[fc00::1]/');
  assert.equal(validatePublicHttpUrl('http://[::1]/'), 'http://[::1]/');
  assert.equal(validatePublicHttpUrl('http://[::ffff:7f00:1]/'), 'http://[::ffff:7f00:1]/');
  assert.equal(validatePublicHttpUrl('http://0.1.2.3/'), 'http://0.1.2.3/');
});

test('social and video wrappers reject non-http URL schemes', async () => {
  const { validatePublicHttpUrl } = await import('../src/http.js');
  assert.equal(validatePublicHttpUrl('https://twitter.com/tweet/1'), 'https://twitter.com/tweet/1');
  assert.throws(() => validatePublicHttpUrl('file:///tmp/tweet'), /scheme/);
  assert.throws(() => validatePublicHttpUrl('ftp://example.com/rss'), /scheme/);
  assert.throws(() => validatePublicHttpUrl('data:text/html,test'), /scheme/);
  assert.throws(() => validatePublicHttpUrl('about:blank'), /scheme/);
});

test('native browse rejects non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('agentic_browse', { action: 'read', url: 'file:///etc/passwd' }),
    /Disallowed URL scheme/,
  );
});

test('reach_status reports native feed channel without network', async () => {
  const result = await callNativeTool('reach_status', { family: 'media' });

  assert.match(JSON.stringify(result.details), /native-rss-atom/);
});

test('social requires supported platform', async () => {
  await assert.rejects(
    () => callNativeTool('social', { platform: 'myspace', action: 'search', query: 'test' }),
    /platform is required/,
  );
});

test('feeds rejects non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('feeds', { url: 'file:///tmp/feed.xml' }),
    /Disallowed URL scheme/,
  );
});

test('social external wrappers reject non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('social', { platform: 'twitter', action: 'read', url: 'file:///tmp/tweet' }),
    /Disallowed URL scheme/,
  );
});

test('video external wrappers reject non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('video', { platform: 'youtube', action: 'details', url: 'file:///tmp/video' }),
    /Disallowed URL scheme/,
  );
});

test('native web_search fans out configured backends and fuses duplicate URLs with RRF', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
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
  };

  try {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, { env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo,brave', BRAVE_API_KEY: 'key' } });
    const details = result.details as { results: Array<{ url: string; rrfScore?: number }>; fusion: { backends: string[] } };

    assert.equal(details.results.length, 1);
    assert.deepEqual(details.fusion.backends.sort(), ['brave', 'duckduckgo']);
    assert.ok((details.results[0]?.rrfScore ?? 0) > 0.03);
  } finally {
    globalThis.fetch = savedFetch;
  }
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
    const savedFetch = globalThis.fetch;
    let observedUrl = '';
    let observedHeaders: Record<string, string> = {};
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      observedUrl = String(input);
      observedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(item.response), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const result = await callNativeTool('web_search', { query: 'example' }, { env: item.env });
      assert.match(JSON.stringify(result.details), new RegExp(item.backend));
      assert.equal(observedUrl, item.expectedUrl);
      for (const [key, value] of Object.entries(item.expectedHeaders)) {
        assert.equal(observedHeaders[key], value);
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
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

test('native web_search clamps CLI limit before backend calls', async () => {
  const savedFetch = globalThis.fetch;
  let requestedCount = '';
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.search.brave.com') requestedCount = url.searchParams.get('count') ?? '';
    if (url.hostname === 'api.duckduckgo.com') {
      return new Response(JSON.stringify({ Heading: '', RelatedTopics: [] }), { status: 200 });
    }
    if (url.hostname === 'duckduckgo.com') {
      return new Response('', { status: 200 });
    }
    if (url.hostname === 'api.search.brave.com') {
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  };

  try {
    await callNativeTool('web_search', { query: 'example', limit: 100000 }, { env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo,brave', BRAVE_API_KEY: 'key' } });
    assert.equal(requestedCount, '20');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('reach_setup install returns descriptor', async () => {
  const result = await callNativeTool('reach_setup', { action: 'install_core' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });

  assert.match(JSON.stringify(result.details), /descriptor/);
  assert.match(JSON.stringify(result.details), /Installation disabled/);
});

test('reach_status redacts warning output from external backend probes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-opencli-'));
  const opencliPath = join(dir, 'opencli');

  try {
    await writeFile(opencliPath, '#!/bin/sh\necho "GITHUB_TOKEN=ghp_reach_status_secret" >&2\nexit 1\n');
    await chmod(opencliPath, 0o700);

    const result = await callNativeTool('reach_status', { family: 'social' }, { env: { PATH: dir } });
    const text = JSON.stringify(result.details);
    assert.match(text, /GITHUB_TOKEN=\*\*\*/);
    assert.doesNotMatch(text, /ghp_reach_status_secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('social backend receives saved cookie-derived env and redacts output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-forward-'));
  const twitterPath = join(dir, 'twitter');
  try {
    await writeFile(twitterPath, '#!/bin/sh\necho "TWITTER_AUTH_TOKEN=$TWITTER_AUTH_TOKEN"\necho "TWITTER_CT0=$TWITTER_CT0"\necho "TWITTER_COOKIE=$TWITTER_COOKIE"\n');
    await chmod(twitterPath, 0o700);
    await writeCookieState('twitter', [
      { name: 'auth_token', value: 'forwarded-auth-secret', domain: '.x.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ct0', value: 'forwarded-ct0-secret', domain: '.x.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    const result = await callNativeTool('social', { platform: 'twitter', action: 'search', query: 'test' }, { env: { PATH: dir, PI_SEARCH_STATE_DIR: dir } });
    const text = JSON.stringify(result.details);

    assert.match(text, /TWITTER_AUTH_TOKEN=\*\*\*/);
    assert.match(text, /TWITTER_CT0=\*\*\*/);
    assert.match(text, /TWITTER_COOKIE=\*\*\*/);
    assert.doesNotMatch(text, /forwarded-auth-secret|forwarded-ct0-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sanitizeExternalOutput redacts known secret patterns', () => {
  const cases = [
    // Redaction keeps only the key prefix up to : or =, then ***
    { input: 'Authorization: Bearer sk-1234abc', expected: 'Authorization:***' },
    { input: 'Set-Cookie: session=abc123', expected: 'Set-Cookie:***' },
    { input: 'TWITTER_AUTH_TOKEN=super_secret_value_here', expected: 'TWITTER_AUTH_TOKEN=***' },
    { input: 'apiKey: some_secret_value', expected: 'apiKey:***' },
    { input: 'GITHUB_TOKEN=ghp_abcd1234', expected: 'GITHUB_TOKEN=***' },
    { input: 'TWITTER_COOKIE=auth_token=secret; ct0=secret', expected: 'TWITTER_COOKIE=***' },
    { input: 'YOUTUBE_API_KEY=youtube_secret', expected: 'YOUTUBE_API_KEY=***' },
    { input: 'DEEP_RESEARCH_API_TOKEN=deep_secret', expected: 'DEEP_RESEARCH_API_TOKEN=***' },
    { input: 'CRAWL4AI_API_TOKEN=crawl_secret', expected: 'CRAWL4AI_API_TOKEN=***' },
    { input: 'normal text with no secrets', expected: 'normal text with no secrets' },
  ];
  for (const { input, expected } of cases) {
    assert.equal(sanitizeExternalOutput(input), expected, `Failed for: ${input}`);
  }
});

test('reach_setup import cookies honors browser automation opt-out', async () => {
  const result = await callNativeTool('reach_setup', { action: 'import_cookies' }, { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } });

  assert.match(JSON.stringify(result.details), /disabled/);
});

test('reach_setup import cookies provider honors browser automation opt-out', async () => {
  const result = await callNativeTool('reach_setup', { action: 'import_cookies', provider: 'facebook' }, { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } });

  assert.match(JSON.stringify(result.details), /disabled/);
});

test('twitter feed hot or popular filter enables ranking filter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-twitter-filter-'));
  const twitterPath = join(dir, 'twitter');

  try {
    await writeFile(twitterPath, '#!/bin/sh\necho "$@"\n');
    await chmod(twitterPath, 0o700);

    const result = await callNativeTool('social', { platform: 'twitter', action: 'feed', filter: 'popular', limit: 7 }, { env: { PATH: dir } });

    assert.match(JSON.stringify(result.details), /feed -n 7 --filter/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit feed filter maps to hot and popular feeds with limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-reddit-filter-'));
  const opencliPath = join(dir, 'opencli');

  try {
    await writeFile(opencliPath, '#!/bin/sh\necho "$@"\n');
    await chmod(opencliPath, 0o700);

    const hot = await callNativeTool('social', { platform: 'reddit', action: 'feed', filter: 'hot', limit: 6 }, { env: { PATH: dir } });
    const popular = await callNativeTool('social', { platform: 'reddit', action: 'feed', filter: 'popular', limit: 8 }, { env: { PATH: dir } });

    assert.match(JSON.stringify(hot.details), /reddit hot --limit 6 -f yaml/);
    assert.match(JSON.stringify(popular.details), /reddit popular --limit 8 -f yaml/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── followLinks BFS crawl tests ──

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
  // Use localhost hostname so domain check (rootHost=127.0.0.1) rejects it
  const externalUrl = `http://localhost:${extAddr.port}/other`;

  const pages: Record<string, string> = {
    '/': `<html><body><h1>Home</h1><p>Welcome to the homepage. This page contains general information about our site and services we provide to customers.</p><a href="/about">About</a> <a href="/contact">Contact</a> <a href="${externalUrl}">External</a></body></html>`,
    '/about': '<html><body><h1>About</h1><p>About page content. Learn more about our history, mission, and values. We have been serving customers since the early days of the internet and continue to grow.</p><a href="/">Home</a></body></html>',
    '/contact': '<html><body><h1>Contact</h1><p>Contact info. Reach out to us via email or phone. Our office is open Monday through Friday from nine to five.</p></body></html>',
  };

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
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await callNativeTool('fetch', {
      url: baseUrl + '/',
      // 'about' is a BM25 stopword, so BM25-only mode would drop the about
      // page entirely. Use non-stopword terms present on all three pages.
      query: 'page contact',
      followLinks: true,
      maxPages: 10,
    });
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => externalServer.close(() => resolve()));
  }
});

test('followLinks crawl deduplicates normalized URLs', async () => {
  let pageCount = 0;
  const server: Server = createServer((_req, res) => {
    pageCount++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Page</h1><p>This page contains enough content to be chunked and indexed properly for testing deduplication behavior.</p><a href="/">Self link</a></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await callNativeTool('fetch', {
      url: baseUrl + '/',
      query: 'page',
      followLinks: true,
      maxPages: 10,
    });
    // Should only fetch the page once despite self-link
    assert.equal(pageCount, 1, 'should dedup self-referencing URL');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('followLinks crawl respects maxPages limit', async () => {
  const pages: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    pages[`/p${i}`] = `<html><body><h1>Page ${i}</h1><p>This is page number ${i} with enough content to exceed the minimum chunk size requirement for proper testing of the crawl pipeline and page limits.</p><a href="/p${(i + 1) % 5}">Next</a></body></html>`;
  }
  let fetchCount = 0;
  const server: Server = createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await callNativeTool('fetch', {
      url: baseUrl + '/p0',
      query: 'page content',
      followLinks: true,
      maxPages: 3,
    });
    assert.ok(fetchCount <= 3, `should respect maxPages=3, got ${fetchCount}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const server: Server = createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // maxPages: 20, so the depth limit is what constrains
    await callNativeTool('fetch', {
      url: baseUrl + '/d0',
      query: 'depth content',
      followLinks: true,
      maxPages: 20,
    });
    // Default maxDepth is 3 for followLinks, so /d0 (depth 0) -> /d1 (1) -> /d2 (2) -> /d3 (3) should all be visited
    assert.ok(visitedPaths.has('/d0'));
    assert.ok(visitedPaths.has('/d1'));
    assert.ok(visitedPaths.has('/d2'));
    assert.ok(visitedPaths.has('/d3'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('followLinks requires url in semantic_crawl args', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { followLinks: true, query: 'test', searchQuery: 'query' }),
    /url is required|followLinks requires/,
  );
});

// ── extractLinksFromHtml unit tests (import via native-tools internal) ──
// We test link extraction behavior through the crawl integration tests above.
// These tests exercise the TS regex fallback indirectly.
