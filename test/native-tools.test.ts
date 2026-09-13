import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import { runCommand, sanitizeExternalOutput } from '../src/reach-tools.js';
import { writeCookieState } from '../src/cookie-jar.js';

// Windows-only skip flag: the tests below spawn extensionless `#!/bin/sh`
// fixture CLIs (opencli/rdt/yt-dlp) through raw spawn(..., { shell: false })
// via reach-tools runCommand / social-opencli defaultExec. Windows
// CreateProcess cannot execute extensionless shell scripts (and those paths
// do not route through spawnCliCommand), so the fixtures never run there.
// The production gap is tracked as a src finding (reach-tools spawn
// portability); the tests stay POSIX-only until it lands.
const requiresPosixSpawn = process.platform === 'win32' ? 'requires POSIX sh spawn' : false;

test('callNativeTool fetch alias routes query-less calls to read', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', {}),
    /url is required/,
  );
});

test('callNativeTool fetch and semantic_crawl reject loopback URLs before connecting', async () => {
  // Both fetch and semantic_crawl should reject private/loopback URLs before connecting
  await assert.rejects(
    () => callNativeTool('fetch', { source: { type: 'url', url: 'http://127.0.0.1:3000/' }, query: 'hello' }),
    /Private\/reserved|Blocked hostname/,
  );
  await assert.rejects(
    () => callNativeTool('semantic_crawl', { source: { type: 'url', url: 'http://127.0.0.1:3000/' }, query: 'hello', maxPages: 1 }),
    /Private\/reserved|Blocked hostname/,
  );
});

test('callNativeTool rejects unsupported tools', async () => {
  await assert.rejects(
    () => callNativeTool('missing_tool', {}),
    /Unsupported native tool/,
  );
});

test('native browse rejects localhost and private URLs — SSRF defense-in-depth', async () => {
  const { validatePublicHttpUrl } = await import('../src/http.js');
  assert.throws(() => validatePublicHttpUrl('http://localhost:3000'), /Blocked hostname/);
  assert.throws(() => validatePublicHttpUrl('http://10.0.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://192.168.1.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://172.16.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://127.0.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://169.254.169.254/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://100.64.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://metadata.google.internal/'), /Blocked hostname/);
});

test('native browse rejects IPv6 link-local, ULAs, and mapped loopback', async () => {
  const { validatePublicHttpUrl } = await import('../src/http.js');
  assert.throws(() => validatePublicHttpUrl('http://[fe80::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://[fd00::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://[fc00::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://[::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://[::ffff:7f00:1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://0.1.2.3/'), /Private\/reserved/);
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
    () => callNativeTool('social', { platform: 'twitter', action: 'get_post', url: 'file:///tmp/tweet' }),
    /scheme must be http or https/,
  );
});

test('video external wrappers reject non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('video', { platform: 'youtube', action: 'details', url: 'file:///tmp/video' }),
    /Disallowed URL scheme/,
  );
});




test('native web_search thin delegation still serves the mocked duckduckgo backend', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return new Response(
        '<html><body><div><a class="result__a" href="https://example.com/delegated">Example</a>' +
        '<a class="result__snippet" href="https://example.com/delegated">Delegated result</a></div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await callNativeTool('web_search', { query: 'example', limit: 5 }, { env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo' } });
    const details = result.details as { results: Array<{ url: string }>; northstar: { data: { kind: string } } };
    assert.equal(details.results.length, 1);
    assert.equal(details.northstar.data.kind, 'entities');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('query-less read surfaces gated external summary and metadata outside source content', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      return new Response('analyze down', { status: 500 });
    }
    if (url.startsWith('https://api.firecrawl.dev/v2/scrape')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown: 'query-less external page words',
          summary: 'QUERYLESS VENDOR SUMMARY',
          metadata: { title: 'Queryless Title' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('native fetch failed');
  };
  try {
    const result = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/article' }, {
      env: {
        DIFFBOT_TOKEN: 'test-token',
        PI_SEARCH_EXTERNAL_FETCH: '1',
        PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
        FIRECRAWL_API_KEY: 'firecrawl-key',
      },
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    });
    const details = result.details as {
      content: string;
      externalFetch: { backend: string; externalProcessing: boolean; qualityImpact: string };
      generatedText: Array<{ kind: string; text: string; provenance: { kind: string } }>;
      fallback?: unknown;
      northstar: { status: string };
    };
    assert.match(details.content, /query-less external page words/);
    assert.doesNotMatch(details.content, /QUERYLESS VENDOR SUMMARY/);
    assert.equal(details.externalFetch.backend, 'firecrawl');
    assert.equal(details.externalFetch.externalProcessing, true);
    assert.equal(details.externalFetch.qualityImpact, 'not_assessed');
    assert.equal(details.generatedText.length, 1);
    assert.equal(details.generatedText[0]?.kind, 'summary');
    assert.match(details.generatedText[0]?.text ?? '', /QUERYLESS VENDOR SUMMARY/);
    assert.equal(details.generatedText[0]?.provenance.kind, 'result_url');
    assert.equal(details.fallback, undefined);
    assert.equal(details.northstar.status, 'degraded');
    assert.doesNotMatch(JSON.stringify(result), /firecrawl-key/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('query-less read surfaces gated external fetch without DIFFBOT_TOKEN', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://api.diffbot.com/v3/analyze')) {
      throw new Error('Analyze must not be called without a token');
    }
    if (url.startsWith('https://api.firecrawl.dev/v2/scrape')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown: 'no-token query-less external page words',
          summary: 'NO-TOKEN QUERYLESS VENDOR SUMMARY',
          metadata: { title: 'No-Token Queryless Title' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('native fetch failed');
  };
  try {
    const result = await callNativeTool('agentic_browse', { action: 'read', url: 'https://example.com/article' }, {
      env: {
        PI_SEARCH_EXTERNAL_FETCH: '1',
        PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
        FIRECRAWL_API_KEY: 'firecrawl-key',
      },
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    });
    const details = result.details as {
      content: string;
      externalFetch: { backend: string; externalProcessing: boolean; qualityImpact: string };
      generatedText: Array<{ kind: string; text: string; provenance: { kind: string } }>;
      fallback?: unknown;
      northstar: { status: string };
    };
    assert.match(details.content, /no-token query-less external page words/);
    assert.doesNotMatch(details.content, /NO-TOKEN QUERYLESS VENDOR SUMMARY/);
    assert.equal(details.externalFetch.backend, 'firecrawl');
    assert.equal(details.externalFetch.externalProcessing, true);
    assert.equal(details.fallback, undefined);
    assert.equal(details.generatedText.length, 1);
    assert.match(details.generatedText[0]?.text ?? '', /NO-TOKEN QUERYLESS VENDOR SUMMARY/);
    assert.doesNotMatch(JSON.stringify(result), /firecrawl-key/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('reach_setup install returns descriptor', async () => {
  const result = await callNativeTool('reach_setup', { action: 'install_core' }, { env: { PI_SEARCH_ALLOW_INSTALL: '0' } });

  assert.match(JSON.stringify(result.details), /descriptor/);
  assert.match(JSON.stringify(result.details), /Installation disabled/);
});

test('reach_status redacts warning output from external backend probes', { skip: requiresPosixSpawn }, async () => {
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

test('sanitizeExternalOutput redacts known secret patterns', () => {
  const cases = [
    // Redaction keeps only the key prefix up to : or =, then ***
    { input: 'Authorization: Bearer sk-1234abc', expected: 'Authorization:***' },
    { input: 'Set-Cookie: session=abc123', expected: 'Set-Cookie:***' },
    { input: 'TWITTER_AUTH_TOKEN=super_secret_value_here', expected: 'TWITTER_AUTH_TOKEN=***' },
    { input: 'apiKey: some_secret_value', expected: 'apiKey:***' },
    { input: 'GITHUB_TOKEN=ghp_abcd1234', expected: 'GITHUB_TOKEN=***' },
    { input: 'TWITTER_COOKIE=auth_token=secret; ct0=secret', expected: 'TWITTER_COOKIE=***' },
    { input: 'auth_token=abc123; ct0=xyz789', expected: 'auth_token=***; ct0=***' },
    { input: 'SESSDATA=abcd1234; bili_jct=xyz999', expected: 'SESSDATA=***; bili_jct=***' },
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
  const result = await callNativeTool('reach_setup', { action: 'import_cookies', provider: 'twitter' }, { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } });

  assert.match(JSON.stringify(result.details), /disabled/);
});

// ── followLinks BFS crawl tests live in test/web.test.ts (restored via the fetchPageText seam) ──





test('followLinks requires url in semantic_crawl args', async () => {
  await assert.rejects(
    () => callNativeTool('fetch', { followLinks: true, query: 'test', searchQuery: 'query' }),
    /url is required|followLinks requires/,
  );
});

// ── extractLinksFromHtml unit tests (import via native-tools internal) ──
// We test link extraction behavior through the crawl integration tests above.
// These tests exercise the TS regex fallback indirectly.

// ── Reddit native resilience ──

const REDDIT_WWW = 'https://www.reddit.com/';

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

test('reddit native cookie: uses stored cookie state via scoped cookieHeaderForUrl match', async () => {
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

test('reddit native API: AbortError rethrown immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  const abortError = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  await assert.rejects(
    withFetch(async (_input, init) => {
      if ((init as RequestInit | undefined)?.signal?.aborted) throw abortError;
      throw new Error(`unexpected fetch ${String(_input)}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
      signal: controller.signal,
    })),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});

test('reddit get_post: non-Reddit host URL rejected before ID extraction', async () => {
  let liveCalled = false;
  await assert.rejects(
    withFetch(async (input) => {
      liveCalled = true;
      throw new Error(`unexpected fetch ${String(input)}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'get_post', url: 'https://example.com/foo' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /not an allowed reddit domain/,
  );
  assert.equal(liveCalled, false, 'no live call may happen for a non-Reddit host');
});

test('reddit get_post: rejects lookalike reddit hosts', async () => {
  for (const url of ['https://notreddit.com/x', 'https://reddit.com.evil.example/x', 'https://www.redd.it.evil.example/x']) {
    await assert.rejects(
      callNativeTool('social', { platform: 'reddit', action: 'get_post', url }, { env: { PATH: '/nonexistent' } }),
      /not an allowed reddit domain/,
      `should reject ${url}`,
    );
  }
});

test('external subprocess env: Reddit API credentials and YouTube key never forwarded to rdt', { skip: requiresPosixSpawn }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-env-iso-'));
  try {
    const rdtPath = join(dir, 'rdt');
    const rdtEnvPath = join(dir, 'rdt.env');
    await writeFile(rdtPath, `#!/bin/sh\n/usr/bin/env | /usr/bin/sort > ${rdtEnvPath}\necho '{"data":{"children":[]}}'\n`);
    await chmod(rdtPath, 0o700);
    const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
      env: {
        PATH: dir,
        REDDIT_CLIENT_ID: 'client-id-value', REDDIT_CLIENT_SECRET: 'client-secret-value',
        YOUTUBE_API_KEY: 'youtube-key-value',
        PI_SEARCH_STATE_DIR: dir,
      },
    });
    const text = JSON.stringify(result.details);
    assert.match(text, /rdt-cli/);
    const captured = await readFile(rdtEnvPath, 'utf8');
    assert.doesNotMatch(captured, /client-id-value/);
    assert.doesNotMatch(captured, /client-secret-value/);
    assert.doesNotMatch(captured, /youtube-key-value/);
    // rdt must never even receive REDDIT_COOKIE: reach tools removed it from
    // the external CLI environment entirely (native cookie path only).
    assert.doesNotMatch(captured, /REDDIT_COOKIE/);
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

test('reach_status: native reddit OAuth and cookie backends reported usable without CLI probes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-status-native-'));
  try {
    const oauth = await callNativeTool('reach_status', { family: 'social' }, {
      env: { PATH: dir, REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1' },
    });
    const oauthChannels = (oauth.details as { channels: Array<Record<string, unknown>> }).channels;
    const oauthReddit = oauthChannels.find((channel: Record<string, unknown>) => channel.name === 'reddit');
    assert.equal(oauthReddit?.status, 'ok');
    assert.equal(oauthReddit?.active_backend, 'reddit-oauth');
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
    assert.match(text, /youtube-data-api/);
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
    assert.match(text, /youtube-data-api/);
    assert.match(text, /Detail Video/);
    assert.match(text, /"durationSeconds":62/);
    assert.match(text, /"viewCount":42/);
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
    assert.match(text, /"author":\{"name":"OChannel"/);
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

test('youtube: transcript uses the unofficial watch-page path, never yt-dlp or the Data API', async () => {
  let apiCalled = false;
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-yt-noclip-'));
  try {
    const result = await withFetch(async (input) => {
      const url = String(input);
      if (url.includes('googleapis.com') || url.includes('youtube.com/oembed')) {
        apiCalled = true;
        return jsonResponse('{}');
      }
      if (url.startsWith('https://www.youtube.com/watch')) {
        return new Response(
          '<html><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.googlevideo.com/api/timedtext?v=x&lang=en","languageCode":"en"}]}}};</script></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      if (url.startsWith('https://www.googlevideo.com/')) {
        return new Response('<transcript><text start="0" dur="2">clip line</text></transcript>', { status: 200 });
      }
      throw new Error(`unexpected fetch ${input}`);
    }, () => callNativeTool('video', { platform: 'youtube', action: 'transcript', url: 'https://www.youtube.com/watch?v=x' }, { env: { PATH: dir, YOUTUBE_API_KEY: 'k' } }));
    const details = result.details as { backend?: string; items?: Array<{ kind?: string; videoId?: string; segments?: Array<{ text?: string }> }> };
    assert.equal(details.backend, 'youtube-transcript');
    assert.equal(details.items?.[0]?.kind, 'video_transcript');
    assert.equal(details.items?.[0]?.videoId, 'x');
    assert.deepEqual(details.items?.[0]?.segments?.map((segment) => segment.text), ['clip line']);
    assert.equal(apiCalled, false, 'transcript must not touch the Data API or oEmbed');
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

test('reddit native get_post: lookalike host URL rejected, host guard intact', async () => {
  await assert.rejects(
    callNativeTool('social', { platform: 'reddit', action: 'get_post', url: 'https://redd.it.example.com/abc123' }, {
      env: { PATH: '/nonexistent' },
    }),
    /not an allowed reddit domain/,
  );
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

test('reach_status: youtube without key is partial (oEmbed details) and never probes yt-dlp', { skip: requiresPosixSpawn }, async () => {
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


test('reddit native get_post: /comments/ path on a non-Reddit host is rejected before ID extraction', async () => {
  let liveCalled = false;
  await assert.rejects(
    withFetch(async (input) => {
      liveCalled = true;
      throw new Error(`unexpected fetch ${String(input)}`);
    }, () => callNativeTool('social', { platform: 'reddit', action: 'get_post', url: 'https://evil.example/comments/abc123' }, {
      env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'pi-atlas/1' },
    })),
    /not an allowed reddit domain/,
  );
  assert.equal(liveCalled, false, 'no live call may happen for a non-Reddit host');
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

test('reddit: pre-aborted signal never spawns a CLI candidate', { skip: requiresPosixSpawn }, async () => {
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

test('reddit: abort during CLI command propagates AbortError without falling through', { skip: requiresPosixSpawn }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cli-abort-'));
  try {
    const opencliPath = join(dir, 'opencli');
    await writeFile(opencliPath, '#!/bin/sh\nwhile :; do :; done\n');
    await chmod(opencliPath, 0o700);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60);

    await assert.rejects(
      withFetch(async (input) => {
        throw new Error(`unexpected network call ${String(input)}`);
      }, () => callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PATH: dir, PI_SEARCH_STATE_DIR: dir },
        signal: controller.signal,
      })),
      abortErrorName,
    );
    clearTimeout(timer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
      /youtube details require id or url/,
    );
    assert.equal(apiCalled, false, `no API call for non-canonical YouTube URL: ${url}`);
  }
});

test('reach_status: native backends are listed in channel metadata and agree with reported backend', async () => {
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
  // failure (eligible for the next candidate), not caller cancellation.
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

test('youtube details: keyed API 401/403 fails closed', async () => {
  // Binding order is the keyed Data API first, then keyless oEmbed. Auth
  // failures (401/403) on the keyed API fail closed without touching oEmbed.
  for (const status of [401, 403]) {
    let oEmbedCalled = false;
    await assert.rejects(
      withFetch(async (input) => {
        const url = String(input);
        if (url.startsWith('https://www.youtube.com/oembed')) { oEmbedCalled = true; return new Response('noembed', { status: 404 }); }
        if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) return new Response('denied', { status });
        throw new Error(`unexpected fetch ${url}`);
      }, () => callNativeTool('video', { platform: 'youtube', action: 'details', id: 'vidX' }, {
        env: { YOUTUBE_API_KEY: 'k' },
      })),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(oEmbedCalled, false, `oEmbed must not run after keyed auth failure (HTTP ${status})`);
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
      /canonical youtube\.com/,
    );
    assert.equal(oEmbedCalled, false, `no oEmbed call for non-canonical URL: ${url}`);
  }
});

test('callNativeTool kg rejects unknown actions before dispatch', async () => {
  await assert.rejects(
    () => callNativeTool('kg', { action: 'crawl' }, { env: {} }),
    /Native kg only supports search, enhance and analyze_text/,
  );
});

test('callNativeTool kg search without token reports no capable provider', async () => {
  await assert.rejects(
    () => callNativeTool('kg', { action: 'search', query: 'type:Person' }, { env: {} }),
    /No capable configured kg provider/,
  );
});

test('callNativeTool kg enhance without selector rejects as invalid input', async () => {
  await assert.rejects(
    () => callNativeTool('kg', { action: 'enhance', type: 'Person' }, { env: {} }),
    /at least one selector/,
  );
});

test('callNativeTool kg analyze_text with empty text rejects as invalid input', async () => {
  await assert.rejects(
    () => callNativeTool('kg', { action: 'analyze_text', text: '' }, { env: {} }),
    /text must be 1\.\.100000 chars/,
  );
});

test('callNativeTool kg explicit unknown provider partitions unsupported_option without fetch', async () => {
  const result = await callNativeTool(
    'kg',
    { action: 'search', query: 'type:Person', providers: ['nope'] },
    { env: {} },
  );
  const details = result.details as { knowledge: { status: string; errors: Array<{ code: string; provider?: string }> } };
  assert.equal(details.knowledge.status, 'error');
  assert.equal(details.knowledge.errors[0]?.code, 'unsupported_option');
  assert.equal(details.knowledge.errors[0]?.provider, 'nope');
  assert.ok(Array.isArray(result.content), 'kg result must carry content');
  const first = (result.content as Array<{ text?: string }>)[0];
  assert.ok(first?.text?.includes('<<<EXTERNAL_EVIDENCE_'), 'kg text must be fenced as untrusted evidence');
});

test('callNativeTool kg rejects cursor with explicit providers', async () => {
  await assert.rejects(
    () => callNativeTool('kg', { action: 'search', query: 'type:Person', providers: ['diffbot'], cursor: 'abc' }, { env: {} }),
    /not supported for explicit multi-provider/,
  );
});

function mockKgFetch(payload: unknown) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = savedFetch;
  };
}

test('callNativeTool kg enhance empty result redacts email selector from text', async () => {
  const restore = mockKgFetch({ data: [] });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', email: 'jane.doe@example.com' },
      { env: { DIFFBOT_TOKEN: 'test-token' } },
    );
    const first = (result.content as Array<{ text?: string }>)[0];
    assert.ok(first?.text?.includes('[REDACTED_EMAIL]'), 'email selector must be redacted in tool text');
    assert.ok(!first?.text?.includes('jane.doe@example.com'), 'raw email must not appear in tool text');
  } finally {
    restore();
  }
});

test('callNativeTool kg enhance empty result redacts phone selector from text', async () => {
  const restore = mockKgFetch({ data: [] });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', phone: '+1-555-123-4567' },
      { env: { DIFFBOT_TOKEN: 'test-token' } },
    );
    const first = (result.content as Array<{ text?: string }>)[0];
    assert.ok(first?.text?.includes('[REDACTED_PHONE]'), 'phone selector must be redacted in tool text');
    assert.ok(!first?.text?.includes('555-123-4567'), 'raw phone must not appear in tool text');
  } finally {
    restore();
  }
});

test('callNativeTool kg search dedupes duplicate entity rows first-wins', async () => {
  const restore = mockKgFetch({
    data: [
      { diffbotUri: 'https://diffbot.com/entity/dup1', type: 'Person', name: 'Jane Doe', pageUrl: 'https://example.com/jane' },
      { diffbotUri: 'https://diffbot.com/entity/dup1', type: 'Person', name: 'Jane Duplicate', pageUrl: 'https://example.com/jane' },
    ],
  });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'search', query: 'type:Person' },
      { env: { DIFFBOT_TOKEN: 'test-token' } },
    );
    const details = result.details as {
      knowledge: { data: { kind: string; entities: Array<{ id: string; name?: string }> } };
    };
    assert.equal(details.knowledge.data.entities.length, 1);
    assert.equal(details.knowledge.data.entities[0]?.name, 'Jane Doe');
    const first = (result.content as Array<{ text?: string }>)[0];
    assert.equal((first?.text?.match(/## 2\./g) ?? []).length, 0, 'duplicate row must not render twice');
  } finally {
    restore();
  }
});

test('callNativeTool kg enhance dedupes duplicate entity rows first-wins', async () => {
  const restore = mockKgFetch({
    data: [
      { diffbotUri: 'https://diffbot.com/entity/dup2', type: 'Person', name: 'Jane Doe', pageUrl: 'https://example.com/jane' },
      { diffbotUri: 'https://diffbot.com/entity/dup2', type: 'Person', name: 'Jane Duplicate', pageUrl: 'https://example.com/jane' },
    ],
  });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe' },
      { env: { DIFFBOT_TOKEN: 'test-token' } },
    );
    const details = result.details as {
      knowledge: { data: { kind: string; entities: Array<{ id: string; name?: string }> } };
    };
    assert.equal(details.knowledge.data.entities.length, 1);
    assert.equal(details.knowledge.data.entities[0]?.name, 'Jane Doe');
  } finally {
    restore();
  }
});

test('callNativeTool kg enhance partition is partial when rows are dropped but entities survive', async () => {
  const restore = mockKgFetch({
    data: [
      { diffbotUri: 'https://diffbot.com/entity/abc123', type: 'Person', name: 'Jane Doe' },
      { error: 'not found', errorCode: 404 },
    ],
  });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe' },
      { env: { DIFFBOT_TOKEN: 'test-token' } },
    );
    const details = result.details as {
      knowledge: {
        status: string;
        data: { partitions: Array<{ provider: string; status: string }> };
        sources: Array<{ provider: string; status: string }>;
      };
    };
    assert.equal(details.knowledge.data.partitions[0]?.status, 'partial');
    assert.equal(details.knowledge.sources[0]?.status, 'partial');
    assert.equal(details.knowledge.status, 'partial');
  } finally {
    restore();
  }
});

// ── kg native-path core integration (spend caps, RRF, enhance assembly) ──

const KG_TOKEN_ENV = { DIFFBOT_TOKEN: 'test-token' };

interface KgTestFetchCounter {
  calls: string[];
}

function mockKgFetchRouter(
  routes: { dql?: unknown; enhance?: unknown; nl?: unknown },
  counter?: KgTestFetchCounter,
): () => void {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    counter?.calls.push(url);
    const payload = url.includes('/kg/v3/enhance')
      ? routes.enhance
      : url.includes('/kg/v3/dql')
        ? routes.dql
        : routes.nl;
    return new Response(JSON.stringify(payload ?? { data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = savedFetch;
  };
}

const KG_ENHANCE_CONFLICT_ROWS = [
  {
    diffbotUri: 'https://diffbot.com/entity/jane',
    type: 'Person',
    name: 'Jane Doe',
    pageUrl: 'https://example.com/jane',
    emailAddresses: [{ contactString: 'jane@example.com' }],
    employments: [
      { employer: { name: 'Acme' }, title: 'Engineer' },
      { employer: { name: 'Globex' }, title: 'Manager' },
    ],
  },
];

interface KgEnhanceTestData {
  kind: string;
  entities: Array<{ id: string; name?: string }>;
  claims: Array<{ subjectId: string; predicate: string; object?: string; provider?: string }>;
  conflicts: Array<{ subjectId: string; predicate: string; object?: string }>;
  partitions: Array<{ provider: string; status: string }>;
  groups?: Array<{ id: string; basis: string; strength: string; members: Array<{ provider: string }> }>;
  evidence?: Array<{ entityId: string; evidence: { status: string } }>;
}

function kgEnhanceData(result: Awaited<ReturnType<typeof callNativeTool>>): KgEnhanceTestData {
  const details = result.details as { knowledge: { data: KgEnhanceTestData } };
  return details.knowledge.data;
}

test('kg enhance surfaces real claims, conflicts, and alignment groups with partitions', async () => {
  const restore = mockKgFetchRouter({ enhance: { data: KG_ENHANCE_CONFLICT_ROWS } });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe' },
      { env: { ...KG_TOKEN_ENV } },
    );
    const data = kgEnhanceData(result);
    assert.equal(data.kind, 'enhance');
    assert.ok(data.claims.length > 0, 'enhance must surface provider-normalized claims');
    assert.ok(
      data.claims.some((claim) => claim.predicate === 'employer' && claim.provider === 'diffbot'),
      'claims keep provider trace tags',
    );
    const employers = data.conflicts.filter((claim) => claim.predicate === 'employer');
    assert.equal(employers.length, 2, 'Acme vs Globex employer rows must surface as conflicts');
    assert.ok(data.groups && data.groups.length === 1, 'enhance must produce one alignment group');
    assert.equal(data.groups?.[0]?.basis, 'canonical_url');
    assert.equal(data.groups?.[0]?.strength, 'exact');
    assert.equal(data.groups?.[0]?.members[0]?.provider, 'diffbot');
    assert.equal(data.partitions.length, 1);
    assert.equal(data.partitions[0]?.status, 'ok');
    assert.equal(data.partitions[0]?.provider, 'diffbot');
    assert.ok(data.evidence && data.evidence.length === 1, 'enhance must carry per-entity evidence');
  } finally {
    restore();
  }
});

test('kg enhance fields option projects claims by Atlas-owned family', async () => {
  const restore = mockKgFetchRouter({ enhance: { data: KG_ENHANCE_CONFLICT_ROWS } });
  try {
    const basic = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe', fields: 'basic' },
      { env: { ...KG_TOKEN_ENV } },
    );
    const basicPredicates = kgEnhanceData(basic).claims.map((claim) => claim.predicate);
    assert.ok(basicPredicates.includes('name'), 'basic keeps name claims');
    assert.ok(!basicPredicates.includes('employer'), 'basic drops professional employer claims');
    const full = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe' },
      { env: { ...KG_TOKEN_ENV } },
    );
    assert.ok(
      kgEnhanceData(full).claims.some((claim) => claim.predicate === 'employer'),
      'omitted fields preserves relationship claims',
    );
  } finally {
    restore();
  }
});

test('kg enhance includeRelationships false suppresses relationship predicates', async () => {
  const restore = mockKgFetchRouter({ enhance: { data: KG_ENHANCE_CONFLICT_ROWS } });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe', includeRelationships: false },
      { env: { ...KG_TOKEN_ENV } },
    );
    const predicates = kgEnhanceData(result).claims.map((claim) => claim.predicate);
    assert.ok(!predicates.includes('employer'), 'relationship predicates suppressed');
    assert.ok(predicates.includes('name'), 'non-relationship claims survive');
  } finally {
    restore();
  }
});

test('kg enhance includeEvidence controls evidence status', async () => {
  const restore = mockKgFetchRouter({ enhance: { data: KG_ENHANCE_CONFLICT_ROWS } });
  try {
    const requested = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe', includeEvidence: true },
      { env: { ...KG_TOKEN_ENV } },
    );
    assert.equal(kgEnhanceData(requested).evidence?.[0]?.evidence.status, 'provided');
    const unrequested = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe' },
      { env: { ...KG_TOKEN_ENV } },
    );
    assert.equal(kgEnhanceData(unrequested).evidence?.[0]?.evidence.status, 'not_requested');
  } finally {
    restore();
  }
});

test('kg enhance confidenceThreshold drops low-confidence entities', async () => {
  const rows = [{ ...KG_ENHANCE_CONFLICT_ROWS[0], confidence: 0.1 }];
  const restore = mockKgFetchRouter({ enhance: { data: rows } });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe', confidenceThreshold: 0.9 },
      { env: { ...KG_TOKEN_ENV } },
    );
    assert.equal(kgEnhanceData(result).entities.length, 0, 'low-confidence entity must be filtered');
  } finally {
    restore();
  }
});

test('kg search over operator spend cap rejects without fetch', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({ dql: { data: [] } }, counter);
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'search', query: 'type:Person', limit: 9 },
      { env: { ...KG_TOKEN_ENV, DIFFBOT_SEARCH_SIZE: '5' } },
    );
    const details = result.details as { knowledge: { errors: Array<{ code: string }> } };
    assert.equal(details.knowledge.errors[0]?.code, 'invalid_input');
    assert.equal(counter.calls.length, 0, 'over-cap search must reject before any paid call');
  } finally {
    restore();
  }
});

test('kg enhance over operator spend cap rejects without fetch', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({ enhance: { data: [] } }, counter);
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe', maxEntities: 5 },
      { env: { ...KG_TOKEN_ENV, DIFFBOT_ENHANCE_SIZE: '1' } },
    );
    const details = result.details as { knowledge: { errors: Array<{ code: string }> } };
    assert.equal(details.knowledge.errors[0]?.code, 'invalid_input');
    assert.equal(counter.calls.length, 0, 'over-cap enhance must reject before any paid call');
  } finally {
    restore();
  }
});

test('kg analyze_text over operator NLP cap rejects without fetch', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({ nl: [] }, counter);
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'analyze_text', text: 'hello world, this is a test' },
      { env: { ...KG_TOKEN_ENV, DIFFBOT_NLP_MAX_CHARS: '5' } },
    );
    const details = result.details as { knowledge: { errors: Array<{ code: string }> } };
    assert.equal(details.knowledge.errors[0]?.code, 'invalid_input');
    assert.equal(counter.calls.length, 0, 'over-cap NLP must reject before any paid call');
  } finally {
    restore();
  }
});

test('kg invalid spend config rejects before any paid call', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({ dql: { data: [] } }, counter);
  try {
    await assert.rejects(
      () => callNativeTool(
        'kg',
        { action: 'search', query: 'type:Person' },
        { env: { ...KG_TOKEN_ENV, DIFFBOT_SEARCH_SIZE: 'banana' } },
      ),
      /DIFFBOT_SEARCH_SIZE/,
    );
    assert.equal(counter.calls.length, 0, 'invalid config must reject before any paid call');
  } finally {
    restore();
  }
});

test('kg public maxProviders above operator cap rejects instead of partitioning', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({ dql: { data: [] } }, counter);
  try {
    await assert.rejects(
      () => callNativeTool(
        'kg',
        { action: 'search', query: 'type:Person', maxProviders: 2 },
        { env: { ...KG_TOKEN_ENV, DIFFBOT_MAX_PROVIDERS: '1' } },
      ),
      /maxProviders.*cap/i,
    );
    assert.equal(counter.calls.length, 0, 'over-cap maxProviders must reject before any paid call');
  } finally {
    restore();
  }
});

test('kg requested providers above operator cap reject instead of partitioning excess', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({ dql: { data: [] } }, counter);
  try {
    await assert.rejects(
      () => callNativeTool(
        'kg',
        { action: 'search', query: 'type:Person', providers: ['diffbot', 'nope'] },
        { env: { ...KG_TOKEN_ENV, DIFFBOT_MAX_PROVIDERS: '1' } },
      ),
      /cap/i,
    );
    assert.equal(counter.calls.length, 0, 'excess providers must reject rather than partition');
  } finally {
    restore();
  }
});

test('kg omitted maxProviders uses configured default cap', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({ dql: { data: [] } }, counter);
  try {
    await assert.rejects(
      () => callNativeTool(
        'kg',
        { action: 'search', query: 'type:Person', providers: ['diffbot', 'a', 'b', 'c'] },
        { env: { ...KG_TOKEN_ENV } },
      ),
      /cap/i,
    );
    assert.equal(counter.calls.length, 0, 'four requested providers exceed the default cap of 3');
  } finally {
    restore();
  }
});

test('kg search single provider preserves fetch order', async () => {
  const restore = mockKgFetchRouter({
    dql: {
      data: [
        { diffbotUri: 'https://diffbot.com/entity/b', type: 'Person', name: 'Bee Second' },
        { diffbotUri: 'https://diffbot.com/entity/a', type: 'Person', name: 'Aye First' },
      ],
    },
  });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'search', query: 'type:Person' },
      { env: { ...KG_TOKEN_ENV } },
    );
    const details = result.details as {
      knowledge: { data: { entities: Array<{ name?: string }> } };
    };
    assert.deepEqual(
      details.knowledge.data.entities.map((entity) => entity.name),
      ['Bee Second', 'Aye First'],
    );
  } finally {
    restore();
  }
});

test('kg enhance public envelope carries opaque alignment ids, never raw identity keys', async () => {
  const restore = mockKgFetchRouter({ enhance: { data: KG_ENHANCE_CONFLICT_ROWS } });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe' },
      { env: { ...KG_TOKEN_ENV } },
    );
    const data = kgEnhanceData(result);
    assert.equal(data.groups?.length, 1);
    assert.equal(data.groups?.[0]?.id, 'alignment:1');
    const serialized = JSON.stringify((result.details as { knowledge: unknown }).knowledge);
    assert.ok(!serialized.includes('canonical_url:'), 'raw alignment key prefix must not leak');
    assert.ok(!serialized.includes('"key"'), 'public groups must not carry key');
    assert.ok(serialized.includes('alignment:1'), 'opaque public id present');
    const employers = data.conflicts.filter((claim) => claim.predicate === 'employer');
    assert.equal(employers.length, 2, 'Acme vs Globex still conflict');
    assert.ok(employers.every((claim) => claim.subjectId === data.groups?.[0]?.id), 'conflicts share the opaque subjectId');
    assert.ok(data.claims.every((claim) => claim.subjectId === data.groups?.[0]?.id));
  } finally {
    restore();
  }
});

test('kg enhance aligned duplicate rows surface cross-row employer conflict', async () => {
  const restore = mockKgFetchRouter({
    enhance: {
      data: [
        { diffbotUri: 'e1', type: 'Person', name: 'Jane Doe', pageUrl: 'https://example.com/jane', employments: [{ employer: { name: 'Acme' } }] },
        { diffbotUri: 'e2', type: 'Person', name: 'Jane Doe', pageUrl: 'https://example.com/jane', employments: [{ employer: { name: 'Globex' } }] },
      ],
    },
  });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'enhance', type: 'Person', name: 'Jane Doe' },
      { env: { ...KG_TOKEN_ENV } },
    );
    const data = kgEnhanceData(result);
    assert.equal(data.groups?.length, 1, 'same pageUrl rows align into one group');
    assert.equal(data.groups?.[0]?.members.length, 2, 'both provider-native rows stay as members');
    const employers = data.conflicts.filter((claim) => claim.predicate === 'employer');
    assert.equal(employers.length, 2, 'Acme vs Globex across aligned rows must conflict');
  } finally {
    restore();
  }
});

test('kg search explicit fanout aggregates rankings with unsupported partition intact', async () => {
  const counter: KgTestFetchCounter = { calls: [] };
  const restore = mockKgFetchRouter({
    dql: {
      data: [
        { diffbotUri: 'https://diffbot.com/entity/b', type: 'Person', name: 'Bee Second' },
        { diffbotUri: 'https://diffbot.com/entity/a', type: 'Person', name: 'Aye First' },
      ],
    },
  }, counter);
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'search', query: 'type:Person', providers: ['diffbot', 'nope'] },
      { env: { ...KG_TOKEN_ENV } },
    );
    const details = result.details as {
      knowledge: {
        data: { entities: Array<{ name?: string }>; partitions?: unknown };
        errors: Array<{ code: string; provider?: string }>;
      };
    };
    assert.deepEqual(
      details.knowledge.data.entities.map((entity) => entity.name),
      ['Bee Second', 'Aye First'],
    );
    assert.equal(details.knowledge.errors[0]?.code, 'unsupported_option');
    assert.equal(details.knowledge.errors[0]?.provider, 'nope');
    assert.equal(counter.calls.length, 1, 'only the capable provider is fetched');
  } finally {
    restore();
  }
});

test('kg enhance aligns distinct names sharing email with opaque conflict subject', async () => {
  const restore = mockKgFetchRouter({
    enhance: {
      data: [
        { diffbotUri: 'https://diffbot.com/entity/email-a', type: 'Person', name: 'Alice Distinct', emailAddresses: [{ contactString: 'shared-align@example.com' }], employments: [{ employer: { name: 'Acme' } }] },
        { diffbotUri: 'https://diffbot.com/entity/email-b', type: 'Person', name: 'Bob Other', emailAddresses: [{ contactString: 'SHARED-ALIGN@example.com' }], employments: [{ employer: { name: 'Globex' } }] },
      ],
    },
  });
  try {
    const result = await callNativeTool('kg', { action: 'enhance', type: 'Person', name: 'Alice' }, { env: { ...KG_TOKEN_ENV } });
    const data = kgEnhanceData(result);
    assert.equal(data.groups?.length, 1);
    assert.equal(data.groups?.[0]?.basis, 'email');
    assert.equal(data.groups?.[0]?.strength, 'strong');
    assert.equal(data.groups?.[0]?.id, 'alignment:1');
    assert.equal(data.groups?.[0]?.members.length, 2);
    const employers = data.conflicts.filter((claim) => claim.predicate === 'employer');
    assert.equal(employers.length, 2);
    assert.ok(employers.every((claim) => claim.subjectId === data.groups?.[0]?.id));
    const serialized = JSON.stringify((result.details as { knowledge: unknown }).knowledge);
    for (const prefix of ['canonical_url:', 'email:', 'phone:', 'external_identifier:', 'provider_id:', 'typed_identity:']) {
      assert.ok(!serialized.includes(prefix), `raw identity-key prefix ${prefix} must not leak`);
    }
    for (const key of ['"signals"', '"emails"', '"phones"', '"externalIds"', '"canonicalUrl"', '"providerId"']) {
      assert.ok(!serialized.includes(key), `raw signals key ${key} must not leak`);
    }
    assert.ok(!serialized.includes('contactString'));
  } finally {
    restore();
  }
});

test('kg enhance aligns distinct names sharing phone with opaque conflict subject', async () => {
  const restore = mockKgFetchRouter({
    enhance: {
      data: [
        { diffbotUri: 'https://diffbot.com/entity/phone-a', type: 'Person', name: 'Carol Distinct', phoneNumbers: [{ contactString: '+1-555-999-0001' }], employments: [{ employer: { name: 'Acme' } }] },
        { diffbotUri: 'https://diffbot.com/entity/phone-b', type: 'Person', name: 'Dave Other', phoneNumbers: [{ contactString: '+1-555-999-0001' }], employments: [{ employer: { name: 'Globex' } }] },
      ],
    },
  });
  try {
    const result = await callNativeTool('kg', { action: 'enhance', type: 'Person', name: 'Carol' }, { env: { ...KG_TOKEN_ENV } });
    const data = kgEnhanceData(result);
    assert.equal(data.groups?.length, 1);
    assert.equal(data.groups?.[0]?.basis, 'phone');
    const employers = data.conflicts.filter((claim) => claim.predicate === 'employer');
    assert.equal(employers.length, 2);
    assert.ok(employers.every((claim) => claim.subjectId === data.groups?.[0]?.id));
    const serialized = JSON.stringify((result.details as { knowledge: unknown }).knowledge);
    assert.ok(!serialized.includes('phone:'));
    assert.ok(!serialized.includes('"signals"'));
  } finally {
    restore();
  }
});

test('kg enhance aligns distinct names sharing external id with opaque conflict subject', async () => {
  const restore = mockKgFetchRouter({
    enhance: {
      data: [
        { diffbotUri: 'https://diffbot.com/entity/ext-a', type: 'Person', name: 'Erin Distinct', wikidata_id: 'Q-align-1', employments: [{ employer: { name: 'Acme' } }] },
        { diffbotUri: 'https://diffbot.com/entity/ext-b', type: 'Person', name: 'Frank Other', wikidata_id: 'Q-align-1', employments: [{ employer: { name: 'Globex' } }] },
      ],
    },
  });
  try {
    const result = await callNativeTool('kg', { action: 'enhance', type: 'Person', name: 'Erin' }, { env: { ...KG_TOKEN_ENV } });
    const data = kgEnhanceData(result);
    assert.equal(data.groups?.length, 1);
    assert.equal(data.groups?.[0]?.basis, 'external_identifier');
    const employers = data.conflicts.filter((claim) => claim.predicate === 'employer');
    assert.equal(employers.length, 2);
    assert.ok(employers.every((claim) => claim.subjectId === data.groups?.[0]?.id));
    const serialized = JSON.stringify((result.details as { knowledge: unknown }).knowledge);
    assert.ok(!serialized.includes('external_identifier:'));
    assert.ok(!serialized.includes('"signals"'));
  } finally {
    restore();
  }
});

test('kg search hostile cursor from rejects cursor_invalid with zero fetch', async () => {
  const { fingerprintKgRequest, issueKgCursor } = await import('../src/knowledge-domain.js');
  const { DIFFBOT_KG_ADAPTER_CURSOR_V, DIFFBOT_KG_MAX_FROM } = await import('../src/diffbot-kg.js');
  const query = 'type:Person';
  const pageSize = 10;
  const fingerprint = fingerprintKgRequest({ action: 'search', query, limit: pageSize, providers: 'auto' });
  const hostileStates = [{ from: -1 }, { from: 1.5 }, { from: DIFFBOT_KG_MAX_FROM + 1 }, { from: DIFFBOT_KG_MAX_FROM - 5 }];
  for (const state of hostileStates) {
    const counter: KgTestFetchCounter = { calls: [] };
    const restore = mockKgFetchRouter({ dql: { data: [] } }, counter);
    try {
      const cursor = issueKgCursor({ provider: 'diffbot', fingerprint, adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V, state: state as { from: number }, fanout: false });
      await assert.rejects(
        () => callNativeTool('kg', { action: 'search', query, limit: pageSize, cursor }, { env: { ...KG_TOKEN_ENV } }),
        /cursor_invalid|Cursor state\.from/i,
      );
      assert.equal(counter.calls.length, 0, `hostile from=${state.from} must reject before any paid call`);
    } finally {
      restore();
    }
  }
  const okCounter: KgTestFetchCounter = { calls: [] };
  const okRestore = mockKgFetchRouter({ dql: { data: [] } }, okCounter);
  try {
    const cursor = issueKgCursor({ provider: 'diffbot', fingerprint, adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V, state: { from: 10 }, fanout: false });
    const result = await callNativeTool('kg', { action: 'search', query, limit: pageSize, cursor }, { env: { ...KG_TOKEN_ENV } });
    const details = result.details as { knowledge: { errors: unknown[] } };
    assert.equal(details.knowledge.errors.length, 0);
    assert.equal(okCounter.calls.length, 1, 'normal cursor pagination must still fetch');
  } finally {
    okRestore();
  }
});

test('kg search terminal page at exact bound reports hasMore false with no cursor', async () => {
  const { fingerprintKgRequest, issueKgCursor } = await import('../src/knowledge-domain.js');
  const { DIFFBOT_KG_ADAPTER_CURSOR_V, DIFFBOT_KG_MAX_FROM } = await import('../src/diffbot-kg.js');
  assert.equal(DIFFBOT_KG_MAX_FROM, 10000);
  const query = 'type:Person';
  const pageSize = 50;
  const fingerprint = fingerprintKgRequest({ action: 'search', query, limit: pageSize, providers: 'auto' });
  const rows = Array.from({ length: pageSize }, (_, i) => ({
    diffbotUri: `https://diffbot.com/entity/terminal-${i}`,
    type: 'Person',
    name: `Terminal ${i}`,
  }));
  const terminalRestore = mockKgFetchRouter({ dql: { data: rows } });
  try {
    const cursor = issueKgCursor({ provider: 'diffbot', fingerprint, adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V, state: { from: 9950 }, fanout: false });
    const result = await callNativeTool(
      'kg',
      { action: 'search', query, limit: pageSize, cursor },
      { env: { ...KG_TOKEN_ENV, DIFFBOT_SEARCH_SIZE: '50' } },
    );
    const details = result.details as { knowledge: { pagination: { hasMore: boolean; nextCursor?: string } } };
    assert.equal(details.knowledge.pagination.hasMore, false);
    assert.equal(details.knowledge.pagination.nextCursor, undefined);
  } finally {
    terminalRestore();
  }
  const earlyRestore = mockKgFetchRouter({ dql: { data: rows } });
  try {
    const result = await callNativeTool(
      'kg',
      { action: 'search', query, limit: pageSize },
      { env: { ...KG_TOKEN_ENV, DIFFBOT_SEARCH_SIZE: '50' } },
    );
    const details = result.details as { knowledge: { pagination: { hasMore: boolean; nextCursor?: string } } };
    assert.equal(details.knowledge.pagination.hasMore, true);
    assert.ok(typeof details.knowledge.pagination.nextCursor === 'string');
  } finally {
    earlyRestore();
  }
});

test('callNativeTool graph delegates without token and reports auth_required', async () => {
  const result = await callNativeTool('graph', { action: 'query', language: 'dql', query: 'type:Organization' }, { env: {} });
  const details = result.details as { graph?: { status?: string; errors?: Array<{ code?: string }> } };
  assert.equal(details.graph?.status, 'error');
  assert.equal(details.graph?.errors?.[0]?.code, 'auth_required');
});
