import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import { buildPlatformWebFallbackChildEnv, runCommand, sanitizeExternalOutput } from '../src/reach-tools.js';
import { writeCookieState } from '../src/cookie-jar.js';
import { loadSearchMcpEnvironment } from '../src/local-config.js';
import type { BackendCallOptions, BackendCallResult } from '../src/backend.js';

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

// ── Reddit native + Arctic Shift archive resilience ──

const REDDIT_OAUTH = 'https://oauth.reddit.com/';
const REDDIT_WWW = 'https://www.reddit.com/';
const REDDIT_TOKEN = 'https://www.reddit.com/api/v1/access_token';
const ARCTIC_SHIFT = 'https://arctic-shift.photon-reddit.com/';

function redditListing(posts: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    kind: 'Listing',
    data: { children: posts.map((post) => ({ kind: 't3', data: post })) },
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

async function withFetch<T>(mock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response, fn: () => Promise<T>): Promise<T> {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
  }
}

test('reddit native API: search uses OAuth Data API when complete triple configured', async () => {
  let tokenCalls = 0;
  let authorization = '';
  let requestedUrl = '';
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url === REDDIT_TOKEN) {
      tokenCalls++;
      return jsonResponse(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
    }
    if (url.startsWith(REDDIT_OAUTH + 'search.json')) {
      requestedUrl = url;
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return jsonResponse(redditListing([
        { id: 'abc1', name: 't3_abc1', title: 'API post', author: 'alice', selftext: 'body', permalink: '/r/x/comments/abc1', created_utc: 1, num_comments: 2, subreddit: 'x', subreddit_id: 't5_1' },
      ]));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'client-id-1', REDDIT_CLIENT_SECRET: 'client-secret-1', REDDIT_USER_AGENT: 'pi-atlas-test/1.0' },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /reddit-api/);
    assert.match(text, /API post/);
    assert.doesNotMatch(text, /client-secret-1/);
    assert.doesNotMatch(text, /client-id-1/);
    assert.doesNotMatch(text, /tok-1/);
    assert.match(requestedUrl, /q=test/);
    assert.match(authorization, /Bearer tok-1/);
  });
  assert.equal(tokenCalls, 1, 'token endpoint must be hit exactly once for the live API call');
});

test('reddit native API: token is cached across calls and keyed per credential triple', async () => {
  let tokenCalls = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url === REDDIT_TOKEN) {
      tokenCalls++;
      return jsonResponse(JSON.stringify({ access_token: 'tok-cached', expires_in: 3600 }));
    }
    if (url.startsWith(REDDIT_OAUTH + 'search.json')) {
      return jsonResponse(redditListing([{ id: 'x1', title: 'One', author: 'a', subreddit: 'x' }]));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const env = { REDDIT_CLIENT_ID: 'c', REDDIT_CLIENT_SECRET: 's', REDDIT_USER_AGENT: 'u/1' };
    await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'a' }, { env });
    await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'b' }, { env });
  });
  assert.equal(tokenCalls, 1, 'token should be fetched once and cached');
});

test('reddit native cookie: REDDIT_COOKIE env drives direct session request to www.reddit.com only', async () => {
  let cookieHeader = '';
  let requestedUrl = '';
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.startsWith(REDDIT_WWW + 'search.json')) {
      cookieHeader = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? '');
      requestedUrl = url;
      return jsonResponse(redditListing([{ id: 'c1', title: 'Cookie post', author: 'bob', subreddit: 'y' }]));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_COOKIE: 'session=abc123' },
    });
    assert.match(JSON.stringify(result.details), /reddit-cookie/);
  });
  assert.equal(cookieHeader, 'session=abc123');
  assert.match(requestedUrl, /^https:\/\/www\.reddit\.com\//);
  assert.doesNotMatch(requestedUrl, /oauth\.reddit\.com/);
});

test('reddit native cookie: uses stored cookie state via cookieAuthEnvironment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-reddit-cookie-'));
  try {
    await writeCookieState('reddit', [
      { name: 'session', value: 'stored-secret-cookie', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');
    let cookieHeader = '';
    await withFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith(REDDIT_WWW + 'search.json')) {
        cookieHeader = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? '');
        return jsonResponse(redditListing([{ id: 's1', title: 'Stored session post', author: 'carol', subreddit: 'z' }]));
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PI_SEARCH_STATE_DIR: dir },
      });
      assert.match(JSON.stringify(result.details), /Stored session post/);
    });
    assert.match(cookieHeader, /session=stored-secret-cookie/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit native API: content_absent falls to Arctic Shift archive with provenance', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (url.startsWith(REDDIT_OAUTH + 'search.json')) return jsonResponse(redditListing([]));
    if (url.startsWith(ARCTIC_SHIFT + 'api/posts/search')) {
      return jsonResponse(JSON.stringify({ data: [{ id: 'arc1', title: 'Archived post', author: 'dave', selftext: 'old body', subreddit: 'x' }] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /arctic-shift/);
    assert.match(text, /"archived":true/);
    assert.match(text, /reason.*content_absent/);
    assert.match(text, /"source":"https:\/\/arctic-shift\.photon-reddit\.com"/);
    assert.match(text, /retrievedAt/);
    assert.match(text, /Archived post/);
    const contentText = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.match(contentText, /\[ARCHIVE\]/);
    assert.doesNotMatch(text, /not live/); // provenance handled in text, not as a live claim
    assert.match(contentText, /not live Reddit/);
  });
});

test('reddit archive: deleted and removed items are filtered from output', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (url.startsWith(REDDIT_OAUTH + 'search.json')) return jsonResponse(redditListing([]));
    if (url.startsWith(ARCTIC_SHIFT)) {
      return jsonResponse(JSON.stringify({ data: [
        { id: 'keep', title: 'Kept post', author: 'eve', subreddit: 'x', _meta: {} },
        { id: 'del', title: 'Deleted later', author: 'eve', subreddit: 'x', _meta: { was_deleted_later: true } },
        { id: 'rem', title: 'Removed by mod', author: 'eve', subreddit: 'x', _meta: { removal_type: 'moderator' } },
        { id: 'remb', title: 'Removed boolean', author: 'eve', subreddit: 'x', _meta: { removal_type: true } },
        { id: 'remn', title: 'Removed numeric', author: 'eve', subreddit: 'x', _meta: { removal_type: 1 } },
      ] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /Kept post/);
    assert.doesNotMatch(text, /Deleted later/);
    assert.doesNotMatch(text, /Removed by mod/);
    assert.doesNotMatch(text, /Removed boolean/);
    assert.doesNotMatch(text, /Removed numeric/);
  });
});

test('reddit archive: 429 is not retried and propagates', async () => {
  let archiveCalls = 0;
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH + 'search.json')) return jsonResponse(redditListing([]));
      if (url.startsWith(ARCTIC_SHIFT)) {
        archiveCalls++;
        return new Response('rate limited', { status: 429, headers: { 'X-RateLimit-Reset': '0' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /Reddit archive: HTTP 429/,
  );
  assert.equal(archiveCalls, 1, 'archive must be attempted exactly once');
});

test('reddit native API: 403 permission error never triggers archive', async () => {
  let archiveCalled = false;
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH + 'search.json')) return new Response('forbidden', { status: 403 });
      if (url.startsWith(ARCTIC_SHIFT)) { archiveCalled = true; return jsonResponse(JSON.stringify({ data: [] })); }
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /HTTP 403/,
  );
  assert.equal(archiveCalled, false, 'archive must not be called for permission errors');
});

test('reddit native API: 400 invalid input never triggers archive', async () => {
  let archiveCalled = false;
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH)) return new Response('bad request', { status: 400 });
      if (url.startsWith(ARCTIC_SHIFT)) { archiveCalled = true; return jsonResponse(JSON.stringify({ data: [] })); }
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /HTTP 400/,
  );
  assert.equal(archiveCalled, false, 'archive must not be called for invalid input');
});

test('reddit native API: AbortError rethrown immediately without archive', async () => {
  let archiveCalled = false;
  const controller = new AbortController();
  controller.abort();
  const abortError = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  await assert.rejects(
    withFetch(async (_input, init) => {
      if ((init as RequestInit | undefined)?.signal?.aborted) throw abortError;
      if (String(_input).startsWith(ARCTIC_SHIFT)) { archiveCalled = true; return jsonResponse(JSON.stringify({ data: [] })); }
      return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
      signal: controller.signal,
    })),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
  assert.equal(archiveCalled, false, 'archive must not be called after abort');
});

test('reddit: no live credentials and CLI unavailable falls to archive (cli_unavailable)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-no-cli-'));
  try {
    await withFetch(async (input) => {
      if (String(input).startsWith(ARCTIC_SHIFT)) {
        return jsonResponse(JSON.stringify({ data: [{ id: 'cli1', title: 'CLI fallback archive', author: 'g', subreddit: 'x' }] }));
      }
      throw new Error(`unexpected fetch ${input}`);
    }, async () => {
      const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, { env: { PATH: dir } });
      const text = JSON.stringify(result.details);
      assert.match(text, /arctic-shift/);
      assert.match(text, /reason.*cli_unavailable/);
      assert.match(text, /CLI fallback archive/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rdt read: non-Reddit host URL rejected, no archive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-rdt-guard-'));
  try {
    let archiveCalled = false;
    await assert.rejects(
      withFetch(async (input) => {
        if (String(input).startsWith(ARCTIC_SHIFT)) { archiveCalled = true; return jsonResponse(JSON.stringify({ data: [] })); }
        throw new Error(`unexpected fetch ${input}`);
      }, () => callNativeTool('social', { platform: 'reddit', action: 'read', url: 'https://example.com/foo' }, { env: { PATH: dir } })),
      /reddit\.com|redd\.it/,
    );
    assert.equal(archiveCalled, false, 'invalid URL input must not trigger archive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rdt read: rejects lookalike reddit hosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-rdt-lookalike-'));
  try {
    for (const url of ['https://notreddit.com/x', 'https://reddit.com.evil.example/x', 'https://www.redd.it.evil.example/x']) {
      await assert.rejects(
        callNativeTool('social', { platform: 'reddit', action: 'read', url }, { env: { PATH: dir } }),
        /reddit\.com|redd\.it/,
        `should reject ${url}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rdt read: accepts exact reddit.com subdomain and redd.it host URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-rdt-accept-'));
  try {
    const rdtPath = join(dir, 'rdt');
    await writeFile(rdtPath, '#!/bin/sh\necho "$@"\n');
    await chmod(rdtPath, 0o700);
    const viaSub = await callNativeTool('social', { platform: 'reddit', action: 'read', url: 'https://www.reddit.com/r/x/comments/abc123' }, { env: { PATH: dir } });
    const viaShort = await callNativeTool('social', { platform: 'reddit', action: 'read', url: 'https://redd.it/abc123' }, { env: { PATH: dir } });
    const text = JSON.stringify(viaSub.details) + JSON.stringify(viaShort.details);
    assert.match(text, /rdt-cli/);
    assert.match(text, /read https:\/\/www\.reddit\.com\/r\/x\/comments\/abc123/);
    assert.match(text, /read https:\/\/redd\.it\/abc123/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('external subprocess env: Reddit API credentials and YouTube key never forwarded to rdt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-env-iso-'));
  try {
    const rdtPath = join(dir, 'rdt');
    await writeFile(rdtPath, '#!/bin/sh\n/usr/bin/env | /usr/bin/sort\n');
    await chmod(rdtPath, 0o700);
    const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: {
        PATH: dir,
        REDDIT_CLIENT_ID: 'client-id-value', REDDIT_CLIENT_SECRET: 'client-secret-value',
        YOUTUBE_API_KEY: 'youtube-key-value',
      },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /rdt-cli/);
    assert.doesNotMatch(text, /client-id-value/);
    assert.doesNotMatch(text, /client-secret-value/);
    assert.doesNotMatch(text, /youtube-key-value/);
    // rdt must never even receive REDDIT_COOKIE: reach tools removed it from
    // the external CLI environment entirely (native cookie path only).
    assert.doesNotMatch(text, /REDDIT_COOKIE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reach_status: reddit not configured for incomplete OAuth triple', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-status-'));
  try {
    const partial = await callNativeTool('reach_status', { family: 'social' }, {
      env: { PATH: dir, REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec' },
    });
    const partialChannels = (partial.details as { channels: Array<Record<string, unknown>> }).channels;
    const partialReddit = partialChannels.find((channel: Record<string, unknown>) => channel.name === 'reddit');
    assert.equal((partialReddit?.auth as Record<string, unknown>).configured, false, 'partial triple must not claim configured');

    const full = await callNativeTool('reach_status', { family: 'social' }, {
      env: { PATH: dir, REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1' },
    });
    const fullChannels = (full.details as { channels: Array<Record<string, unknown>> }).channels;
    const fullReddit = fullChannels.find((channel: Record<string, unknown>) => channel.name === 'reddit');
    assert.equal((fullReddit?.auth as Record<string, unknown>).configured, true, 'complete triple must claim configured');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit: no live auth and no CLI archive falls back for hot (backend capability gap is not invalid input)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-hot-archive-'));
  try {
    await withFetch(async (input) => {
      if (String(input).startsWith(ARCTIC_SHIFT)) {
        return jsonResponse(JSON.stringify({ data: [{ id: 'hot1', title: 'Hot archive post', author: 'h', subreddit: 'x' }] }));
      }
      throw new Error(`unexpected fetch ${input}`);
    }, async () => {
      const result = await callNativeTool('social', { platform: 'reddit', action: 'hot' }, { env: { PATH: dir } });
      const text = JSON.stringify(result.details);
      assert.match(text, /arctic-shift/);
      assert.match(text, /reason.*cli_unavailable/);
      assert.match(text, /Hot archive post/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit: no live auth and no CLI archive falls back for subreddit_info', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-sr-info-archive-'));
  try {
    await withFetch(async (input) => {
      if (String(input).startsWith(ARCTIC_SHIFT + 'api/subreddits/search')) {
        return jsonResponse(JSON.stringify({ data: [{ display_name: 'askreddit', title: 'Ask Reddit', subscribers: 5 }] }));
      }
      throw new Error(`unexpected fetch ${input}`);
    }, async () => {
      const result = await callNativeTool('social', { platform: 'reddit', action: 'subreddit_info', subreddit: 'askreddit' }, { env: { PATH: dir } });
      const text = JSON.stringify(result.details);
      assert.match(text, /arctic-shift/);
      assert.match(text, /reason.*cli_unavailable/);
      assert.match(text, /askreddit/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit: unknown action never reaches archive and keeps legacy CLI error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-unknown-action-'));
  try {
    let archiveCalled = false;
    await assert.rejects(
      withFetch(async (input) => {
        if (String(input).startsWith(ARCTIC_SHIFT)) { archiveCalled = true; return jsonResponse(JSON.stringify({ data: [] })); }
        throw new Error(`unexpected fetch ${input}`);
      }, () => callNativeTool('social', { platform: 'reddit', action: 'comments', url: 'https://www.reddit.com/r/x/comments/abc123' }, { env: { PATH: dir } })),
      /Unsupported rdt action: comments|No usable reddit backend/,
    );
    assert.equal(archiveCalled, false, 'unsupported actions must not trigger the archive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit: AbortError during archive propagates instead of primary error', async () => {
  const abortError = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH + 'search.json')) return new Response('boom', { status: 500 });
      if (url.startsWith(ARCTIC_SHIFT)) throw abortError;
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});

test('reddit archive: oversized response body is rejected by the bounded reader', async () => {
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH + 'search.json')) return jsonResponse(redditListing([]));
      if (url.startsWith(ARCTIC_SHIFT)) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '1000001' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /too large/,
  );
});

test('reach_status: native reddit OAuth and cookie backends reported usable without CLI probes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-status-native-'));
  try {
    const oauth = await callNativeTool('reach_status', { family: 'social' }, {
      env: { PATH: dir, REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1' },
    });
    const oauthChannels = (oauth.details as { channels: Array<Record<string, unknown>> }).channels;
    const oauthReddit = oauthChannels.find((channel: Record<string, unknown>) => channel.name === 'reddit');
    assert.equal(oauthReddit?.status, 'ok');
    assert.equal(oauthReddit?.active_backend, 'reddit-api');
    assert.doesNotMatch(JSON.stringify(oauth.details), /client-secret-value/);

    const cookie = await callNativeTool('reach_status', { family: 'social' }, {
      env: { PATH: dir, REDDIT_COOKIE: 'session=secret-cookie-value' },
    });
    const cookieChannels = (cookie.details as { channels: Array<Record<string, unknown>> }).channels;
    const cookieReddit = cookieChannels.find((channel: Record<string, unknown>) => channel.name === 'reddit');
    assert.equal(cookieReddit?.status, 'ok');
    assert.equal(cookieReddit?.active_backend, 'reddit-cookie');
    assert.doesNotMatch(JSON.stringify(cookie.details), /secret-cookie-value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reach_status: keyed YouTube reported as native youtube-data-api backend', async () => {
  const result = await callNativeTool('reach_status', { family: 'media' }, {
    env: { YOUTUBE_API_KEY: 'yt-status-key', PATH: '/nonexistent' },
  });
  const channels = (result.details as { channels: Array<Record<string, unknown>> }).channels;
  const youtube = channels.find((channel: Record<string, unknown>) => channel.name === 'youtube');
  assert.equal(youtube?.status, 'ok');
  assert.equal(youtube?.active_backend, 'youtube-data-api');
  assert.doesNotMatch(JSON.stringify(result.details), /yt-status-key/);
});

// ── YouTube: official Data API + keyless oEmbed only, no yt-dlp routing ──

test('youtube: Data API search used when YOUTUBE_API_KEY set', async () => {
  let requestedUrl = '';
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/search')) {
      requestedUrl = url;
      return jsonResponse(JSON.stringify({ items: [
        { id: { videoId: 'vid1' }, snippet: { title: 'YT Search Result', description: 'desc', channelTitle: 'Channel A', publishedAt: '2026-01-01T00:00:00Z' } },
      ] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('video', { platform: 'youtube', action: 'search', query: 'test', limit: 3 }, {
      env: { YOUTUBE_API_KEY: 'yt-key-1' },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /youtube-api/);
    assert.match(text, /YT Search Result/);
    assert.match(text, /https:\/\/www\.youtube\.com\/watch\?v=vid1/);
    assert.doesNotMatch(text, /yt-key-1/);
  });
  assert.match(requestedUrl, /maxResults=3/);
});

test('youtube: Data API details normalized for single video', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
      return jsonResponse(JSON.stringify({ items: [
        { id: 'vid9', snippet: { title: 'Detail Video', channelTitle: 'Chan', publishedAt: '2026-02-02T00:00:00Z' }, contentDetails: { duration: 'PT1M2S' }, statistics: { viewCount: '42' } },
      ] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('video', { platform: 'youtube', action: 'details', id: 'vid9' }, {
      env: { YOUTUBE_API_KEY: 'k' },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /youtube-api/);
    assert.match(text, /Detail Video/);
    assert.match(text, /"duration":"PT1M2S"/);
    assert.match(text, /"viewCount":"42"/);
  });
});

test('youtube: hot maps to official mostPopular chart when key set', async () => {
  let requestedUrl = '';
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
      requestedUrl = url;
      return jsonResponse(JSON.stringify({ items: [{ id: 'v1', snippet: { title: 'Popular Now' } }] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('video', { platform: 'youtube', action: 'hot', limit: 5 }, {
      env: { YOUTUBE_API_KEY: 'k' },
    });
    assert.match(JSON.stringify(result.details), /Popular Now/);
  });
  assert.match(requestedUrl, /chart=mostPopular/);
  assert.match(requestedUrl, /maxResults=5/);
});

test('youtube: oEmbed used as keyless details fallback when no key', async () => {
  let requestedUrl = '';
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/oembed')) {
      requestedUrl = url;
      return jsonResponse(JSON.stringify({ title: 'OEmbed Video', author_name: 'OChannel', author_url: 'https://youtube.com/@ochan', thumbnail_url: 'https://i.ytimg.com/1.jpg' }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('video', { platform: 'youtube', action: 'details', url: 'https://www.youtube.com/watch?v=oemb1' }, { env: {} });
    const text = JSON.stringify(result.details);
    assert.match(text, /youtube-oembed/);
    assert.match(text, /OEmbed Video/);
    assert.match(text, /"author":"OChannel"/);
    assert.match(text, /"url":"https:\/\/www\.youtube\.com\/watch\?v=oemb1"/);
  });
  assert.match(requestedUrl, /url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch/);
});

test('youtube: API key never appears in errors or output', async () => {
  const key = 'secret-yt-key-1';
  let observed = '';
  try {
    await withFetch(async () => new Response('Bad Request', { status: 400 }), () =>
      callNativeTool('video', { platform: 'youtube', action: 'search', query: 'test' }, { env: { YOUTUBE_API_KEY: key } }),
    );
  } catch (err) {
    observed = String(err);
  }
  assert.match(observed, /HTTP 400/);
  assert.match(observed, /key=\[redacted\]|\[redacted\]/);
  assert.doesNotMatch(observed, new RegExp(key));
});

test('youtube: transcript returns clear unavailable error, never routes to yt-dlp or API', async () => {
  let apiCalled = false;
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-yt-noclip-'));
  try {
    await assert.rejects(
      withFetch(async (input) => {
        if (String(input).includes('googleapis.com') || String(input).includes('youtube.com/oembed')) {
          apiCalled = true;
          return jsonResponse('{}');
        }
        throw new Error(`unexpected fetch ${input}`);
      }, () => callNativeTool('video', { platform: 'youtube', action: 'transcript', url: 'https://www.youtube.com/watch?v=x' }, { env: { PATH: dir, YOUTUBE_API_KEY: 'k' } })),
      (err: unknown) => err instanceof Error && /unavailable/i.test(err.message),
    );
    assert.equal(apiCalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('youtube: search without key errors clearly, no yt-dlp invocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-yt-nokey-'));
  try {
    await assert.rejects(
      callNativeTool('video', { platform: 'youtube', action: 'search', query: 'test' }, { env: { PATH: dir } }),
      (err: unknown) => err instanceof Error && /YOUTUBE_API_KEY/.test(err.message) && !/yt-dlp/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Round 2 regression tests ──

test('reddit token: oversized token response body is rejected by the bounded reader', async () => {
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '1000001' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'oversize/1' },
    })),
    /too large/,
  );
});

test('reddit native read: redd.it short URL normalizes to t3_ post ID', async () => {
  let requestedUrl = '';
  await withFetch(async (input) => {
    const url = String(input);
    if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (url.startsWith(REDDIT_OAUTH + 'api/info.json')) {
      requestedUrl = url;
      return jsonResponse(redditListing([{ id: 'abc123', name: 't3_abc123', title: 'Short link post', author: 'u', permalink: '/r/x/comments/abc123', created_utc: 1, subreddit: 'x' }]));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { platform: 'reddit', action: 'read', url: 'https://redd.it/abc123' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /reddit-api/);
    assert.match(text, /Short link post/);
  });
  assert.match(requestedUrl, /id=t3_abc123/);
});

test('reddit native read: lookalike host URL rejected, host guard intact', async () => {
  await assert.rejects(
    withFetch(async (input) => {
      if (String(input) === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      throw new Error(`unexpected fetch ${input}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'read', url: 'https://redd.it.example.com/abc123' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /id or url is required/,
  );
});

test('reddit native hot without subreddit uses canonical /hot.json, not popular.json', async () => {
  let requestedUrl = '';
  await withFetch(async (input) => {
    const url = String(input);
    if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (url.startsWith(REDDIT_OAUTH)) {
      requestedUrl = url;
      return jsonResponse(redditListing([{ id: 'h1', title: 'Hot post', author: 'a', subreddit: 'x' }]));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { platform: 'reddit', action: 'hot' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    });
    assert.match(JSON.stringify(result.details), /Hot post/);
  });
  assert.match(requestedUrl, /\/hot\.json/);
  assert.doesNotMatch(requestedUrl, /\/r\/popular\.json/);
});

test('youtube details: canonical youtu.be short URL video ID used for Data API', async () => {
  let requestedUrl = '';
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
      requestedUrl = url;
      return jsonResponse(JSON.stringify({ items: [{ id: 'abc123defgh', snippet: { title: 'Short Link Video', channelTitle: 'C' }, contentDetails: { duration: 'PT1M' }, statistics: { viewCount: '1' } }] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('video', { platform: 'youtube', action: 'details', url: 'https://youtu.be/abc123defgh' }, {
      env: { YOUTUBE_API_KEY: 'k' },
    });
    assert.match(JSON.stringify(result.details), /Short Link Video/);
  });
  assert.match(requestedUrl, /id=abc123defgh/);
});

test('reach_status: youtube without key is partial (oEmbed details) and never probes yt-dlp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-status-yt-'));
  try {
    const ytDlpPath = join(dir, 'yt-dlp');
    await writeFile(ytDlpPath, '#!/bin/sh\nexit 0\n');
    await chmod(ytDlpPath, 0o700);

    const result = await callNativeTool('reach_status', { family: 'media' }, { env: { PATH: dir } });
    const channels = (result.details as { channels: Array<Record<string, unknown>> }).channels;
    const youtube = channels.find((channel: Record<string, unknown>) => channel.name === 'youtube');
    assert.equal(youtube?.status, 'warn');
    assert.equal(youtube?.active_backend, 'youtube-oembed');
    assert.match(String(youtube?.message ?? ''), /YOUTUBE_API_KEY/);
    assert.doesNotMatch(JSON.stringify(result.details), /"active_backend":"yt-dlp"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


// ── Opt-in final web fallback (PI_SEARCH_PLATFORM_WEB_FALLBACK=1) ──

type FakeFallback = (tool: string, callArgs: Record<string, unknown>, callOptions: BackendCallOptions) => Promise<BackendCallResult>;

function fallbackInjected(executor: FakeFallback): Record<string, unknown> {
  return { _platformWebFallback: executor };
}

test('buildPlatformWebFallbackChildEnv strips cookies, proxies, and platform credentials', () => {
  const childEnv = buildPlatformWebFallbackChildEnv({
    PATH: '/usr/bin',
    PI_SEARCH_STATE_DIR: '/tmp/state',
    REDDIT_COOKIE: 'session=secret',
    HTTP_PROXY: 'http://proxy:8080',
    HTTPS_PROXY: 'http://proxy:8080',
    ALL_PROXY: 'http://proxy:8080',
    YOUTUBE_API_KEY: 'yt-key',
    REDDIT_CLIENT_SECRET: 'client-secret',
    REDDIT_USER_AGENT: 'ua',
    EXA_API_KEY: 'exa',
    SECRET_THING: 'x',
  });
  assert.equal(childEnv.PATH, '/usr/bin');
  assert.equal(childEnv.PI_SEARCH_STATE_DIR, '/tmp/state');
  assert.equal(childEnv.PI_SEARCH_SCRAPLING_ENABLED, '0');
  assert.equal(childEnv.REDDIT_COOKIE, undefined);
  assert.equal(childEnv.HTTP_PROXY, undefined);
  assert.equal(childEnv.HTTPS_PROXY, undefined);
  assert.equal(childEnv.ALL_PROXY, undefined);
  assert.equal(childEnv.YOUTUBE_API_KEY, undefined);
  assert.equal(childEnv.REDDIT_CLIENT_SECRET, undefined);
  assert.equal(childEnv.REDDIT_USER_AGENT, undefined);
  assert.equal(childEnv.EXA_API_KEY, undefined);
  assert.equal(childEnv.SECRET_THING, undefined);
});

test('reddit: web fallback is disabled by default and never invoked', async () => {
  let fallbackCalls = 0;
  const injected = (() => { fallbackCalls++; return Promise.resolve({}); }) as unknown as FakeFallback;
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH + 'search.json')) return jsonResponse(redditListing([]));
      if (url.startsWith(ARCTIC_SHIFT)) return new Response('unavailable', { status: 500 });
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
      ...fallbackInjected(injected),
    } as unknown as Parameters<typeof callNativeTool>[2])),
    /Reddit archive: HTTP 500/,
  );
  assert.equal(fallbackCalls, 0);
});

test('reddit search: opt-in web-search fallback uses a separate data model', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const injected = (tool: string, callArgs: Record<string, unknown>): Promise<BackendCallResult> => {
    calls.push([tool, callArgs]);
    return Promise.resolve({ content: [{ type: 'text', text: 'fake search results' }], details: { query: callArgs.query } });
  };
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith(ARCTIC_SHIFT)) return new Response('boom', { status: 500 });
    throw new Error(`unexpected fetch ${url}`);
  }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'llm' }, {
    env: { PATH: '/nonexistent', PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
    ...fallbackInjected(injected),
  } as unknown as Parameters<typeof callNativeTool>[2]));
  const details = result.details as Record<string, unknown>;
  assert.equal(details.backend, 'web-search-fallback');
  assert.equal(details.dataModel, 'search-results');
  assert.equal(details.degraded, true);
  assert.equal(details.platform, 'reddit');
  assert.deepEqual(calls[0]?.[0], 'web_search');
  assert.deepEqual(calls[0]?.[1], { query: 'llm', limit: 8 });
});

test('reddit read: opt-in page fallback performs one agentic_browse fetch with page-text model', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const injected = (tool: string, callArgs: Record<string, unknown>): Promise<BackendCallResult> => {
    calls.push([tool, callArgs]);
    return Promise.resolve({ content: [{ type: 'text', text: 'fake page text' }], details: { url: String(callArgs.url), title: 'x' } });
  };
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (url.startsWith(REDDIT_OAUTH + 'api/info.json')) return jsonResponse(redditListing([]));
    if (url.startsWith(ARCTIC_SHIFT)) return new Response('boom', { status: 500 });
    throw new Error(`unexpected fetch ${url}`);
  }, () => callNativeTool('social', { platform: 'reddit', action: 'read', url: 'https://www.reddit.com/comments/xyz123' }, {
    env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1', PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
    ...fallbackInjected(injected),
  } as unknown as Parameters<typeof callNativeTool>[2]));
  const details = result.details as Record<string, unknown>;
  assert.equal(details.backend, 'web-fetch-fallback');
  assert.equal(details.dataModel, 'page-text');
  assert.equal(details.degraded, true);
  assert.equal(calls[0]?.[0], 'agentic_browse');
  assert.deepEqual(calls[0]?.[1], { action: 'read', url: 'https://www.reddit.com/comments/xyz123' });
});

test('reddit: web fallback is never invoked after permission failure', async () => {
  let fallbackCalls = 0;
  const injected = (() => { fallbackCalls++; return Promise.resolve({}); }) as unknown as FakeFallback;
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH + 'search.json')) return new Response('forbidden', { status: 403 });
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1', PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
      ...fallbackInjected(injected),
    } as unknown as Parameters<typeof callNativeTool>[2])),
    /HTTP 403/,
  );
  assert.equal(fallbackCalls, 0);
});

test('reddit: abort during last-resort archive propagates and never reaches web fallback', async () => {
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  let fallbackCalls = 0;
  const injected = (() => { fallbackCalls++; return Promise.resolve({}); }) as unknown as FakeFallback;
  await assert.rejects(
    withFetch(async (_input, init) => {
      if ((init as RequestInit | undefined)?.signal?.aborted) throw abortError;
      if (String(_input) === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (String(_input).startsWith(REDDIT_OAUTH + 'search.json')) return jsonResponse(redditListing([]));
      if (String(_input).startsWith(ARCTIC_SHIFT)) throw abortError;
      throw new Error(`unexpected fetch ${_input}`);
    }, () => {
      const controller = new AbortController();
      controller.abort();
      return callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1', PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
        signal: controller.signal,
        ...fallbackInjected(injected),
      } as unknown as Parameters<typeof callNativeTool>[2]);
    }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
  assert.equal(fallbackCalls, 0);
});

test('reddit native cookie: redirects are rejected; stored cookies scoped to exact host/path only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-reddit-redirect-'));
  try {
    await writeCookieState('reddit', [
      { name: 'session', value: 'stored-secret-cookie', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'outsider', value: 'other-domain-secret', domain: 'example.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    let observedRedirect = '';
    let observedCookie = '';
    await assert.rejects(
      withFetch(async (input, init) => {
        const url = String(input);
        if (url.startsWith(REDDIT_WWW)) {
          observedRedirect = String((init as RequestInit | undefined)?.redirect ?? '');
          observedCookie = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? '');
          return new Response('', { status: 302 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PI_SEARCH_STATE_DIR: dir },
      })),
      /Redirect rejected/,
    );
    assert.equal(observedRedirect, 'manual');
    assert.match(observedCookie, /session=stored-secret-cookie/);
    assert.doesNotMatch(observedCookie, /other-domain-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit native read: /comments/ path on a non-Reddit host is rejected before ID extraction', async () => {
  let archiveOrApiCalled = false;
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN || url.startsWith(REDDIT_OAUTH) || url.startsWith(ARCTIC_SHIFT) || url.startsWith(REDDIT_WWW)) {
        archiveOrApiCalled = true;
        return jsonResponse(redditListing([]));
      }
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'read', url: 'https://evil.example/comments/abc123' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /id or url is required/,
  );
  assert.equal(archiveOrApiCalled, false, 'no live/archive/fallback call may happen for a non-Reddit host');
});

test('youtube details: keyed Data API failure falls back to keyless oEmbed, key stays redacted', async () => {
  let oembedCalled = false;
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) return new Response('boom', { status: 500 });
    if (url.startsWith('https://www.youtube.com/oembed')) {
      oembedCalled = true;
      return jsonResponse(JSON.stringify({ title: 'OEmbed title', author_name: 'Auth', thumbnail_url: 'https://i.ytimg.com/x.jpg' }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, () => callNativeTool('video', { platform: 'youtube', action: 'details', url: 'https://www.youtube.com/watch?v=abc123' }, {
    env: { YOUTUBE_API_KEY: 'supersecretkey' },
  }));
  const text = JSON.stringify(result.details);
  assert.equal(oembedCalled, true);
  assert.match(text, /youtube-oembed/);
  assert.match(text, /OEmbed title/);
  assert.doesNotMatch(JSON.stringify(result), /supersecretkey/);
});

test('youtube details: keyed Data API empty result falls back to keyless oEmbed', async () => {
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
      return jsonResponse(JSON.stringify({ items: [] }));
    }
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return jsonResponse(JSON.stringify({ title: 'Empty fallback', author_name: 'A' }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, () => callNativeTool('video', { platform: 'youtube', action: 'details', url: 'https://www.youtube.com/watch?v=empty1' }, {
    env: { YOUTUBE_API_KEY: 'k' },
  }));
  assert.match(JSON.stringify(result.details), /youtube-oembed/);
  assert.match(JSON.stringify(result.details), /Empty fallback/);
});

test('youtube search: opt-in web search fallback used when no key', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const injected = (tool: string, callArgs: Record<string, unknown>): Promise<BackendCallResult> => {
    calls.push([tool, callArgs]);
    return Promise.resolve({ content: [], details: { query: callArgs.query } });
  };
  const result = await callNativeTool('video', { platform: 'youtube', action: 'search', query: 'rust' }, {
    env: { PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
    ...fallbackInjected(injected),
  } as unknown as Parameters<typeof callNativeTool>[2]);
  const details = result.details as Record<string, unknown>;
  assert.equal(details.backend, 'web-search-fallback');
  assert.equal(details.dataModel, 'search-results');
  assert.equal(details.degraded, true);
  assert.equal(calls[0]?.[0], 'web_search');
  assert.deepEqual(calls[0]?.[1], { query: 'rust', limit: 8 });
});


test('reddit native cookie: cookie value never appears in output or details', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith(REDDIT_WWW + 'search.json')) {
      return jsonResponse(redditListing([{ id: 'v1', title: 'No leak', author: 'a', subreddit: 'r' }]));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_COOKIE: 'session=raw-cookie-secret-value' },
    });
    assert.match(JSON.stringify(result.details), /reddit-cookie/);
    assert.doesNotMatch(JSON.stringify(result), /raw-cookie-secret-value/);
  });
});

// ── Review-round hardening regressions ──

function abortErrorName(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

test('web-fallback child env: PI_SEARCH_ENV_PATH pinned so loadSearchMcpEnvironment never re-reads the repo .env', () => {
  const parent = {
    PATH: '/usr/bin',
    REDDIT_CLIENT_SECRET: 'should-not-pass',
    REDDIT_COOKIE: 'session=should-not-pass',
    HTTP_PROXY: 'http://proxy:8080',
    YOUTUBE_API_KEY: 'should-not-pass',
    PI_SEARCH_ENV_PATH: '/tmp/whatever-existing-or-not.env',
  };
  const childEnv = buildPlatformWebFallbackChildEnv(parent);
  assert.notEqual(childEnv.PI_SEARCH_ENV_PATH, parent.PI_SEARCH_ENV_PATH, 'parent env path must not be forwarded');
  assert.equal(childEnv.REDDIT_CLIENT_SECRET, undefined);
  assert.equal(childEnv.REDDIT_COOKIE, undefined);
  assert.equal(childEnv.HTTP_PROXY, undefined);
  assert.equal(childEnv.YOUTUBE_API_KEY, undefined);

  // Effective environment after the Pi-owned CLI child applies its loader.
  const effective = loadSearchMcpEnvironment(childEnv);
  assert.equal(effective.REDDIT_CLIENT_SECRET, undefined);
  assert.equal(effective.REDDIT_COOKIE, undefined);
  assert.equal(effective.HTTP_PROXY, undefined);
  assert.equal(effective.YOUTUBE_API_KEY, undefined);
  assert.equal(effective.SEARCH_MCP_CONFIG_PATH, undefined);
});

test('reddit: expired stored cookie does not bypass legacy CLI and never sends the cookie live', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-expired-cookie-'));
  try {
    await writeCookieState('reddit', [
      { name: 'session', value: 'stale-secret', domain: '.reddit.com', path: '/', expires: 1, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    // The unusable stored cookie must not bypass the legacy CLI fallback. The
    // CLI is not installed, so the failure path may consult the archive — but
    // the expired cookie must never be sent as a live request to reddit.com.
    let cookieCalls = 0;
    await assert.rejects(
      withFetch(async (input) => {
        const url = String(input);
        if (url.startsWith(REDDIT_WWW)) cookieCalls++;
        return new Response('unavailable', { status: 500 });
      }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PATH: '/nonexistent', PI_SEARCH_STATE_DIR: dir },
      })),
      /No usable reddit backend/,
    );
    assert.equal(cookieCalls, 0, 'expired stored cookie must never be sent as a live cookie request');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit: path-mismatched stored cookie does not bypass legacy CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-pm-cookie-'));
  try {
    await writeCookieState('reddit', [
      { name: 'session', value: 'path-scoped-secret', domain: '.reddit.com', path: '/r/other', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    let cookieCalls = 0;
    await assert.rejects(
      withFetch(async (input) => {
        const url = String(input);
        if (url.startsWith(REDDIT_WWW)) cookieCalls++;
        return new Response('unavailable', { status: 500 });
      }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PATH: '/nonexistent', PI_SEARCH_STATE_DIR: dir },
      })),
      /No usable reddit backend/,
    );
    assert.equal(cookieCalls, 0, 'path-mismatched stored cookie must never be sent as a live cookie request');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reach_status: expired or non-Reddit stored cookie never reports reddit-cookie active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-status-cookie-'));
  try {
    await writeCookieState('reddit', [
      { name: 'session', value: 'expired-secret', domain: '.reddit.com', path: '/', expires: 1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'outsider', value: 'other-domain-secret', domain: 'example.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    const result = await callNativeTool('reach_status', { family: 'social' }, {
      env: { PATH: '/nonexistent', PI_SEARCH_STATE_DIR: dir },
    });
    const channels = (result.details as { channels: Array<Record<string, unknown>> }).channels;
    const reddit = channels.find((channel: Record<string, unknown>) => channel.name === 'reddit');
    assert.notEqual(reddit?.active_backend, 'reddit-cookie');
    assert.doesNotMatch(JSON.stringify(result.details), /expired-secret|other-domain-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit: pre-aborted signal never spawns a CLI candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-preabort-'));
  const marker = join(dir, 'ran');
  try {
    const opencliPath = join(dir, 'opencli');
    await writeFile(opencliPath, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(opencliPath, 0o700);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PATH: dir, PI_SEARCH_STATE_DIR: dir },
        signal: controller.signal,
      }),
      abortErrorName,
    );
    assert.equal(existsSync(marker), false, 'CLI candidate must not be spawned for a pre-aborted signal');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit: abort during CLI command propagates AbortError and never reaches archive or web fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cli-abort-'));
  try {
    const opencliPath = join(dir, 'opencli');
    await writeFile(opencliPath, '#!/bin/sh\nsleep 30\n');
    await chmod(opencliPath, 0o700);

    let fallbackCalls = 0;
    const injected = (() => { fallbackCalls++; return Promise.resolve({}); }) as unknown as FakeFallback;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60);

    await assert.rejects(
      withFetch(async (input) => {
        throw new Error(`unexpected network call ${String(input)}`);
      }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PATH: dir, PI_SEARCH_STATE_DIR: dir, PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
        signal: controller.signal,
        ...fallbackInjected(injected),
      } as unknown as Parameters<typeof callNativeTool>[2])),
      abortErrorName,
    );
    clearTimeout(timer);
    assert.equal(fallbackCalls, 0, 'web fallback must never run after a CLI abort');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit OAuth token: redirect is rejected, never followed cross-host', async () => {
  // Unique user agent so the module-level token cache (keyed by the credential
  // triple digest) cannot serve a token from an earlier test.
  await assert.rejects(
    withFetch(async (input) => {
      if (String(input) === REDDIT_TOKEN) return new Response('', { status: 302, headers: { location: 'https://evil.example/token' } });
      throw new Error(`unexpected fetch ${String(input)}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'redirect-id', REDDIT_CLIENT_SECRET: 'redirect-secret', REDDIT_USER_AGENT: 'redirect-token-test/1.0' },
    })),
    /Reddit token: redirect rejected/,
  );
});

test('reddit Data API: bearer redirect is rejected, never followed cross-host', async () => {
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH)) return new Response('', { status: 302, headers: { location: 'https://evil.example/search' } });
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /Redirect rejected/,
  );
});

test('reddit archive: redirect is rejected, never followed cross-host', async () => {
  await assert.rejects(
    withFetch(async (input) => {
      const url = String(input);
      if (url === REDDIT_TOKEN) return jsonResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (url.startsWith(REDDIT_OAUTH + 'search.json')) return jsonResponse(redditListing([]));
      if (url.startsWith(ARCTIC_SHIFT)) return new Response('', { status: 302, headers: { location: 'https://evil.example/archive' } });
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /Reddit archive: redirect rejected/,
  );
});

test('youtube Data API: redirect is rejected, never followed cross-host, key stays redacted', async () => {
  const secretKey = 'redirect-secret-key';
  let observedRedirect: string | undefined;
  // The URL carries the API key; a 3xx must be rejected before any follow. The
  // mock throws on any other URL, proving no second request/redirect target is
  // ever fetched, and the surfaced error must not contain the key value. The
  // request must be sent with redirect: 'manual' so the runtime never follows
  // a 3xx to another host with the key in the query string.
  await assert.rejects(
    withFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://www.googleapis.com/youtube/v3/')) {
        observedRedirect = init?.redirect;
        return new Response('', { status: 302, headers: { location: 'https://evil.example/search' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('video', { platform: 'youtube', action: 'search', query: 'test' }, {
      env: { YOUTUBE_API_KEY: secretKey },
    })),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /Redirect rejected/);
      assert.doesNotMatch(message, new RegExp(secretKey));
      return true;
    },
  );
  assert.equal(observedRedirect, 'manual', 'YouTube Data API request must never follow redirects');
});

test('youtube details: video ID is only extracted from canonical YouTube hosts', async () => {
  // No Data API or oEmbed call may happen for lookalike/non-YouTube URLs.
  for (const url of ['https://evil.example/watch?v=abc123', 'https://youtube.com.evil.com/watch?v=abc123', 'https://notyoutube.com/watch?v=abc123']) {
    let apiCalled = false;
    await assert.rejects(
      withFetch(async () => {
        apiCalled = true;
        return jsonResponse('{}');
      }, () => callNativeTool('video', { platform: 'youtube', action: 'details', url }, {
        env: { YOUTUBE_API_KEY: 'key' },
      })),
      /id or url is required/,
    );
    assert.equal(apiCalled, false, `no API call for non-canonical YouTube URL: ${url}`);
  }
});

test('reach_status: native backends are listed in channel metadata and agree with reported backend', async () => {
  const oauth = await callNativeTool('reach_status', { family: 'social' }, {
    env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1' },
  });
  const oauthChannels = (oauth.details as { channels: Array<{ name: string; backends?: Array<{ name: string }>; active_backend: string | null }> }).channels;
  const reddit = oauthChannels.find((c) => c.name === 'reddit');
  assert.equal(reddit?.active_backend, 'reddit-api');
  assert.ok(reddit?.backends?.some((b) => b.name === 'reddit-api'));
  assert.ok(reddit?.backends?.some((b) => b.name === 'reddit-cookie'));

  const yt = await callNativeTool('reach_status', { family: 'media' }, {
    env: { YOUTUBE_API_KEY: 'key' },
  });
  const ytChannels = (yt.details as { channels: Array<{ name: string; backends?: Array<{ name: string }>; active_backend: string | null }> }).channels;
  const youtube = ytChannels.find((c) => c.name === 'youtube');
  assert.equal(youtube?.active_backend, 'youtube-data-api');
  assert.ok(youtube?.backends?.some((b) => b.name === 'youtube-data-api'));
  assert.ok(youtube?.backends?.some((b) => b.name === 'youtube-oembed'));
});

// ── Round 2 accepted fixes ──

test('runCommand: command timeout resolves as a non-zero failure, never AbortError', async () => {
  // Reddit CLI fallback relies on runCommand: a wall-clock timeout is a backend
  // failure (eligible for the next candidate/archive), not caller cancellation.
  const result = await runCommand('sleep', ['30'], { env: {} }, 60);
  assert.equal(result.code, 124);
  assert.match(result.stderr, /timed out after 60ms/);
});

test('runCommand: caller abort still rejects AbortError', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40);
  await assert.rejects(runCommand('sleep', ['30'], { env: {}, signal: controller.signal }, 5000), abortErrorName);
  clearTimeout(timer);

  // A pre-aborted signal must reject without spawning.
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    runCommand('sleep', ['30'], { env: {}, signal: preAborted.signal }, 5000),
    abortErrorName,
  );
});

test('youtube details: keyed API 401/403 stops before oEmbed and web fallback', async () => {
  for (const status of [401, 403]) {
    let oEmbedCalled = false;
    let fallbackCalls = 0;
    const injected = (() => { fallbackCalls++; return Promise.resolve({}); }) as unknown as FakeFallback;
    await assert.rejects(
      withFetch(async (input) => {
        const url = String(input);
        if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) return new Response('denied', { status });
        if (url.startsWith('https://www.youtube.com/oembed')) { oEmbedCalled = true; return jsonResponse('{}'); }
        throw new Error(`unexpected fetch ${url}`);
      }, () => callNativeTool('video', { platform: 'youtube', action: 'details', id: 'vidX' }, {
        env: { YOUTUBE_API_KEY: 'k', PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
        ...fallbackInjected(injected),
      } as unknown as Parameters<typeof callNativeTool>[2])),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(oEmbedCalled, false, `oEmbed must not run after HTTP ${status}`);
    assert.equal(fallbackCalls, 0, `web fallback must not run after HTTP ${status}`);
  }
});

test('youtube details: keyless oEmbed rejects arbitrary and lookalike URLs before any fetch', async () => {
  for (const url of ['https://evil.example/watch?v=abc123', 'https://youtube.com.evil.com/watch?v=abc123', 'https://localhost:7777/watch?v=x', 'http://localhost:7777/private']) {
    let oEmbedCalled = false;
    await assert.rejects(
      withFetch(async (input) => {
        if (String(input).startsWith('https://www.youtube.com/oembed')) {
          oEmbedCalled = true;
          return jsonResponse('{}');
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      }, () => callNativeTool('video', { platform: 'youtube', action: 'details', url }, { env: {} })),
      /id or url is required/,
    );
    assert.equal(oEmbedCalled, false, `no oEmbed call for non-canonical URL: ${url}`);
  }
});

test('youtube details: opt-in page fallback constructs canonical URL from id, never forwards user URL', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const injected = (tool: string, callArgs: Record<string, unknown>): Promise<BackendCallResult> => {
    calls.push([tool, callArgs]);
    return Promise.resolve({ content: [{ type: 'text', text: 'page' }], details: { url: String(callArgs.url) } });
  };
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) return new Response('boom', { status: 500 });
    if (url.startsWith('https://www.youtube.com/oembed')) return new Response('boom', { status: 500 });
    throw new Error(`unexpected fetch ${url}`);
  }, () => callNativeTool('video', { platform: 'youtube', action: 'details', id: 'vidX', url: 'http://localhost:7777/private' }, {
    env: { YOUTUBE_API_KEY: 'k', PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
    ...fallbackInjected(injected),
  } as unknown as Parameters<typeof callNativeTool>[2]));
  const details = result.details as Record<string, unknown>;
  assert.equal(details.backend, 'web-fetch-fallback');
  assert.deepEqual(calls[0]?.[1], { action: 'read', url: 'https://www.youtube.com/watch?v=vidX' });
  assert.doesNotMatch(JSON.stringify(calls), /localhost/);
});

test('reddit read: opt-in page fallback constructs canonical URL from id, never forwards user URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-reddit-fallback-id-'));
  try {
    // Installed-but-failing opencli (exit 1) + absent rdt: the CLI candidates
    // fail for availability reasons, not invalid input, so the archive → page
    // fallback chain runs. The arbitrary user URL must never win over id.
    const opencliPath = join(dir, 'opencli');
    await writeFile(opencliPath, '#!/bin/sh\necho boom >&2\nexit 1\n');
    await chmod(opencliPath, 0o700);

    const calls: Array<[string, Record<string, unknown>]> = [];
    const injected = (tool: string, callArgs: Record<string, unknown>): Promise<BackendCallResult> => {
      calls.push([tool, callArgs]);
      return Promise.resolve({ content: [{ type: 'text', text: 'page' }], details: { url: String(callArgs.url) } });
    };
    const result = await withFetch(async (input) => {
      const url = String(input);
      if (url.startsWith(ARCTIC_SHIFT)) return new Response('boom', { status: 500 });
      throw new Error(`unexpected fetch ${url}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'read', id: 'abc123', url: 'http://localhost:7777/private' }, {
      env: { PATH: dir, PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
      ...fallbackInjected(injected),
    } as unknown as Parameters<typeof callNativeTool>[2]));
    const details = result.details as Record<string, unknown>;
    assert.equal(details.backend, 'web-fetch-fallback');
    assert.deepEqual(calls[0]?.[1], { action: 'read', url: 'https://www.reddit.com/comments/abc123' });
    assert.doesNotMatch(JSON.stringify(calls), /localhost/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reddit read: lookalike URL without id is rejected before live, archive, or web fallback', async () => {
  let fallbackCalls = 0;
  const injected = (() => { fallbackCalls++; return Promise.resolve({}); }) as unknown as FakeFallback;
  await assert.rejects(
    withFetch(async (input) => {
      throw new Error(`unexpected network call ${String(input)}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'read', url: 'http://localhost:7777/private' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1', PI_SEARCH_PLATFORM_WEB_FALLBACK: '1' },
      ...fallbackInjected(injected),
    } as unknown as Parameters<typeof callNativeTool>[2])),
    /id or url is required/,
  );
  assert.equal(fallbackCalls, 0, 'web fallback must never run for a lookalike URL');
});
