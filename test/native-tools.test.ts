import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import { runCommand, sanitizeExternalOutput } from '../src/reach-tools.js';
import { writeCookieState } from '../src/cookie-jar.js';

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
    if (url.startsWith('https://api.duckduckgo.com/')) {
      return new Response(JSON.stringify({
        Heading: 'Example',
        AbstractURL: 'https://example.com/delegated',
        AbstractText: 'Delegated result',
        RelatedTopics: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
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

test('external subprocess env: Reddit API credentials and YouTube key never forwarded to rdt', async () => {
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

test('reddit: abort during CLI command propagates AbortError without falling through', async () => {
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
