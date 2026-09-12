import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';
import { callReachTool, externalEnvironment } from '../src/reach-tools.js';
import { writeCookieState } from '../src/cookie-jar.js';
import { openCliChildEnv } from '../src/social-opencli.js';

const REDDIT_TOKEN = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_WWW = 'https://www.reddit.com/';

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function redditListing(children: Array<Record<string, unknown>>): string {
  return JSON.stringify({ data: { children: children.map((child) => ({ data: child })) } });
}

async function withFetch<T>(mock: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => mock(input, init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

async function withExecutableDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-northstar-reach-'));
}

async function writeShim(dir: string, name: string, body: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, body);
  await chmod(path, 0o700);
  if (process.platform === 'win32') {
    // Windows CreateProcess skips PATHEXT lookup, so prod resolves bare
    // commands to their on-disk extension (resolveCliCommand) and spawns
    // shell:false. Emit a .cmd twin for that resolution to find: env-dump
    // bodies use `set` (same KEY=value shape; avoids nested-quote breakage
    // of node -e under cmd.exe), echo bodies print their payload (without
    // sh single-quotes), then exit with the same code.
    const dumpMatch = />\s*(\S+)\s*$/.exec(body.split('\n').find((line) => line.includes('>')) ?? '');
    const payloads = [...body.matchAll(/echo\s+'([^']*)'/g)].map((m) => m[1] ?? '');
    const exitMatch = /exit\s+(\d+)/.exec(body);
    const lines = ['@echo off'];
    if (dumpMatch?.[1]) {
      lines.push(`set > ${JSON.stringify(dumpMatch[1])}`);
    }
    for (const payload of payloads) lines.push(`echo ${payload}`);
    lines.push(`exit /b ${exitMatch?.[1] ?? '0'}`);
    await writeFile(`${path}.cmd`, `${lines.join('\r\n')}\r\n`);
  }
}

/** Prepend a shim dir to the real process PATH (workers that sanitize from
 *  process.env resolve shims first); always restores the previous value. */
async function withShimmedPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = 'PATH';
  const previous = process.env[key];
  process.env[key] = `${dir}${delimiter}${previous ?? ''}`;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

const FAIL_SHIM = '#!/bin/sh\nexit 127\n';

// ── Action-aware reach status ──

test('reach_status: action filters eligibility (keyless youtube cannot serve search)', async () => {
  const channels = async (env: Record<string, string>) => {
    const result = await callNativeTool('reach_status', { family: 'media', action: 'search' }, { env });
    return ((result.details as { channels: Array<Record<string, unknown>> }).channels);
  };
  const youtube = (await channels({ PATH: '/nonexistent' })).find((c) => c.name === 'youtube');
  assert.equal(youtube?.status, 'off', 'keyless oEmbed cannot serve search');
  assert.equal(youtube?.active_backend, null);
  assert.match(String(youtube?.message), /search/);
  // Canonical registry vocabulary is always reported.
  assert.deepEqual(youtube?.actions, ['search', 'details', 'hot', 'transcript']);
});

test('reach_status: action-aware youtube eligibility with key and for details', async () => {
  const keyed = await callNativeTool('reach_status', { family: 'media', action: 'search' }, { env: { YOUTUBE_API_KEY: 'k', PATH: '/nonexistent' } });
  const channels = (keyed.details as { channels: Array<Record<string, unknown>> }).channels;
  const youtube = channels.find((c) => c.name === 'youtube');
  assert.equal(youtube?.status, 'ok');
  assert.equal(youtube?.active_backend, 'youtube-data-api');

  // transcript is served keylessly by the unofficial youtube-transcript adapter
  // (executeMedia plans it regardless of API key).
  const transcript = await callNativeTool('reach_status', { family: 'media', action: 'transcript' }, { env: { YOUTUBE_API_KEY: 'k', PATH: '/nonexistent' } });
  const ytTranscript = ((transcript.details as { channels: Array<Record<string, unknown>> }).channels).find((c) => c.name === 'youtube');
  assert.equal(ytTranscript?.status, 'warn');
  assert.equal(ytTranscript?.active_backend, 'youtube-transcript');
  assert.match(String(ytTranscript?.message), /transcript/);

  const keylessTranscript = await callNativeTool('reach_status', { family: 'media', action: 'transcript' }, { env: { PATH: '/nonexistent' } });
  const ytKeyless = ((keylessTranscript.details as { channels: Array<Record<string, unknown>> }).channels).find((c) => c.name === 'youtube');
  assert.equal(ytKeyless?.status, 'warn');
  assert.equal(ytKeyless?.active_backend, 'youtube-transcript');
});

test('reach_status: unsupported action reports off instead of a usable backend', async () => {
  const result = await callNativeTool('reach_status', { family: 'media', action: 'transcript' }, { env: { PATH: '/nonexistent' } });
  const channels = (result.details as { channels: Array<Record<string, unknown>> }).channels;
  const rss = channels.find((c) => c.name === 'rss');
  assert.equal(rss?.status, 'off');
  assert.match(String(rss?.message), /not a supported rss action/);
  const youtube = channels.find((c) => c.name === 'youtube');
  assert.equal(youtube?.status, 'warn');
  assert.equal(youtube?.active_backend, 'youtube-transcript');
});

test('reach_status without action keeps channel-level reporting', async () => {
  const result = await callNativeTool('reach_status', { family: 'media' }, { env: { YOUTUBE_API_KEY: 'k', PATH: '/nonexistent' } });
  const channels = (result.details as { channels: Array<Record<string, unknown>> }).channels;
  const youtube = channels.find((c) => c.name === 'youtube');
  assert.equal(youtube?.status, 'ok');
  assert.equal(youtube?.active_backend, 'youtube-data-api');
});

// ── Exact hostname/subdomain platform inference (never substring) ──

test('platform inference rejects lookalike hosts instead of inferring', async () => {
  for (const url of ['https://notreddit.com/x', 'https://reddit.com.evil.example/x', 'https://twitter.com.evil.example/1']) {
    await assert.rejects(
      () => callNativeTool('social', { url, action: 'read' }),
      /platform is required/,
      `must not infer from ${url}`,
    );
  }
});

test('platform inference uses exact/subdomain registry matching for routing', async () => {
  const dir = await withExecutableDir();
  try {
    // x.com is a registry domain; a tweet URL infers twitter and the twitter-cli
    // fixture normalizes through the Stage 2 integrator.
    await writeShim(dir, 'twitter', '#!/bin/sh\necho \'[{"id":"1","text":"hello thread","author":{"screenName":"user"}}]\'\n');
    const result = await callNativeTool('social', { url: 'https://x.com/user/status/1', action: 'get_thread' }, { env: { PATH: dir } });
    const details = result.details as { platform?: string; backend?: string; canonicalAction?: string };
    assert.equal(details.platform, 'twitter');
    assert.equal(details.backend, 'twitter-cli');
    assert.equal(details.canonicalAction, 'get_thread');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('platform inference routes v2ex topic urls without any subprocess', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/api/topics/show.json')) return jsonResponse('[{"id":123,"title":"t"}]');
    if (url.includes('/api/replies/show.json')) return jsonResponse('[]');
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('social', { url: 'https://www.v2ex.com/t/123', action: 'get_thread' }, { env: {} });
    const details = result.details as { platform?: string; canonicalAction?: string };
    assert.equal(details.platform, 'v2ex');
    assert.equal(details.canonicalAction, 'get_thread');
  });
});

// ── Exit-0 semantic validation: empty/error payloads keep fallback alive ──

test('exit 0 with empty payload exhausts backends instead of succeeding', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'twitter', '#!/bin/sh\nexit 0\n');
    await assert.rejects(
      () => callNativeTool('social', { platform: 'twitter', action: 'search', query: 'test' }, { env: { PATH: dir } }),
      (err: unknown) => err instanceof Error && /No usable twitter backend/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exit 0 with an explicit error JSON payload never becomes a result', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'twitter', '#!/bin/sh\necho \'{"error":"blocked"}\'\nexit 0\n');
    await assert.rejects(
      () => callNativeTool('social', { platform: 'twitter', action: 'search', query: 'test' }, { env: { PATH: dir } }),
      (err: unknown) => err instanceof Error && /No usable twitter backend/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exit 0 with usable payload still succeeds', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'twitter', '#!/bin/sh\necho \'[{"id":"2","text":"payload tweet"}]\'\n');
    const result = await callNativeTool('social', { platform: 'twitter', action: 'search', query: 'test' }, { env: { PATH: dir } });
    assert.equal((result.details as { backend?: string }).backend, 'twitter-cli');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capability-aware backend eligibility ──

test('reddit legacy spellings throw unsupported_action (canonical-only)', async () => {
  await assert.rejects(
    () => callNativeTool('social', { platform: 'reddit', action: 'all' }, {
      env: { REDDIT_COOKIE: 'session=raw-cookie' },
    }),
    /Unsupported reddit action: all/,
  );
});

test('reach_status reports registry backends with installed/responding/authenticated/actionVerified', async () => {
  const result = await callNativeTool('reach_status', { family: 'social' }, { env: { PATH: '/nonexistent' } });
  const channels = (result.details as { channels: Array<Record<string, unknown>> }).channels;
  const reddit = channels.find((c) => c.name === 'reddit');
  assert.ok(Array.isArray(reddit?.backends), 'social status derives backend availability from the registry');
  const cookie = ((reddit?.backends as Array<Record<string, unknown>>)).find((b) => b.backend === 'reddit-cookie');
  assert.equal(cookie?.mode, 'native');
  assert.equal(cookie?.authenticated, false);
  assert.equal(cookie?.actionVerified, true);
  assert.equal(cookie?.completeness, 'full');
});

// ── Cookie use / non-use ──

test('reddit: raw cookie session wins over optional API credentials (binding auth order)', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'opencli', FAIL_SHIM);
    await writeShim(dir, 'rdt', FAIL_SHIM);
    let requestedUrl = '';
    let tokenCalls = 0;
    await withShimmedPath(dir, () => withFetch(async (input) => {
      const url = String(input);
      if (url.startsWith(REDDIT_WWW + 'search.json')) {
        requestedUrl = url;
        return jsonResponse(redditListing([{ id: 'c1', title: 'Cookie post', author: 'bob', subreddit: 'y' }]));
      }
      if (url === REDDIT_TOKEN) {
        tokenCalls += 1;
        return jsonResponse(JSON.stringify({ access_token: 'tok' }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: {
          REDDIT_COOKIE: 'session=raw-cookie',
          REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1',
        },
      });
      assert.match(JSON.stringify(result.details), /reddit-cookie/);
    }));
    assert.match(requestedUrl, /^https:\/\/www\.reddit\.com\//, 'cookie session must hit www.reddit.com, not oauth');
    assert.equal(tokenCalls, 0, 'cookie tier must serve before the API-key tier is consulted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stored reddit cookies are only sent for scoped Reddit hosts', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'opencli', FAIL_SHIM);
    await writeShim(dir, 'rdt', FAIL_SHIM);
    await writeCookieState('reddit', [
      { name: 'session', value: 'stored-secret-cookie', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');
    let cookieHeader = '';
    await withShimmedPath(dir, () => withFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith(REDDIT_WWW + 'search.json')) {
        cookieHeader = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? '');
        return jsonResponse(redditListing([{ id: 's1', title: 'Stored post', author: 'c', subreddit: 'z' }]));
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await callNativeTool('social', { platform: 'reddit', action: 'search', query: 'test' }, {
        env: { PATH: dir, PI_SEARCH_STATE_DIR: dir },
      });
      assert.match(JSON.stringify(result.details), /reddit-cookie/);
    }));
    assert.match(cookieHeader, /session=stored-secret-cookie/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('opencli child env never carries cookies, keys, or secrets', () => {
  const env = openCliChildEnv({
    PATH: '/x', HOME: '/h', OPENCLI_HOST: 'cli.example', OPENCLI_TOKEN: 'operator-token',
    REDDIT_COOKIE: 'c', GITHUB_TOKEN: 'g', TWITTER_AUTH_TOKEN: 't', OTHER_SECRET: 's', FOO: 'bar',
  });
  // Operator-owned OpenCLI connection settings pass through; everything
  // secret-bearing or unrelated is dropped before the subprocess spawns.
  assert.deepEqual(env, { PATH: '/x', HOME: '/h', OPENCLI_HOST: 'cli.example', OPENCLI_TOKEN: 'operator-token' });
});

test('reach_status never claims browser actions unsupported (registry is not browser-action truth)', async () => {
  const result = await callReachTool('reach_status', { family: 'browser', action: 'click' }, { env: { PATH: '/usr/bin' } });
  const channels = (result?.details as { channels?: Array<{ name?: string; status?: string; message?: string }> } | undefined)?.channels ?? [];
  const browser = channels.find((channel) => channel.name === 'browser');
  assert.ok(browser, 'browser channel must be reported');
  assert.doesNotMatch(browser.message ?? '', /not a supported browser action/);
  assert.match(browser.message ?? '', /BROWSER_ACTIONS/);
});

test('facebook stored cookies are never forwarded to any backend (unused credentials)', async () => {
  const dir = await withExecutableDir();
  try {
    await writeCookieState('facebook', [
      { name: 'xs', value: 'facebook-xs-secret', domain: '.facebook.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');
    await writeShim(dir, 'opencli', FAIL_SHIM);
    await withShimmedPath(dir, async () => {
      await assert.rejects(
        () => callNativeTool('social', { platform: 'facebook', action: 'search', query: 'test' }, {
          env: { PATH: dir, PI_SEARCH_STATE_DIR: dir },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /No usable facebook backend/);
          assert.doesNotMatch(err.message, /facebook-xs-secret/);
          return true;
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── V2EX canonical `read` alongside legacy `topic` ──

test('v2ex canonical get_thread works; legacy topic throws unsupported_action', async () => {
  const urls: string[] = [];
  await withFetch(async (input) => {
    urls.push(String(input));
    if (String(input).includes('/api/replies/show.json')) return jsonResponse('[]');
    return jsonResponse('[{"id":123,"title":"t"}]');
  }, async () => {
    const canonical = await callNativeTool('social', { platform: 'v2ex', action: 'get_thread', postId: '123' }, { env: {} });
    const canonicalDetails = canonical.details as { action?: string; canonicalAction?: string };
    assert.equal(canonicalDetails.action, 'get_thread');
    assert.equal(canonicalDetails.canonicalAction, 'get_thread');
    await assert.rejects(
      () => callNativeTool('social', { platform: 'v2ex', action: 'topic', postId: '123' }, { env: {} }),
      /Unsupported v2ex action: topic/,
    );
  });
  // Order-insensitive: the two legacy fetches race through independent DNS
  // preflights, so fetch-invocation order is not deterministic. Both must fire.
  assert.ok(urls.some((u) => /topics\/show\.json\?id=123/.test(u)), `topics fetch missing in ${JSON.stringify(urls)}`);
  assert.ok(urls.some((u) => /replies\/show\.json\?topic_id=123/.test(u)), `replies fetch missing in ${JSON.stringify(urls)}`);
});

// ── YouTube details binding order: keyed Data API first, keyless oEmbed fallback ──

test('youtube details: keyed Data API wins before keyless oEmbed', async () => {
  const calls: string[] = [];
  await withFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
      return jsonResponse(JSON.stringify({ items: [{ id: 'vid123', snippet: { title: 'api title', channelTitle: 'c', publishedAt: '2024-01-01' } }] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('media', { platform: 'youtube', action: 'details', id: 'vid123' }, { env: { YOUTUBE_API_KEY: 'k' } });
    assert.equal((result.details as { backend?: string }).backend, 'youtube-data-api');
  });
  assert.equal(
    calls.filter((url) => url.startsWith('https://www.youtube.com/oembed')).length,
    0,
    'keyless oEmbed must not be called when the keyed Data API succeeds',
  );
});

test('youtube details: keyless oEmbed is the fallback tier after Data API retryable failure', async () => {
  const calls: string[] = [];
  await withFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
      return new Response('boom', { status: 500 });
    }
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return jsonResponse(JSON.stringify({ title: 'fallback title', author_name: 'a' }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('media', { platform: 'youtube', action: 'details', id: 'vid123' }, { env: { YOUTUBE_API_KEY: 'k' } });
    assert.equal((result.details as { backend?: string }).backend, 'youtube-oembed');
  });
  assert.match(calls[0]!, /^https:\/\/www\.googleapis\.com\/youtube/);
  assert.match(calls[1]!, /^https:\/\/www\.youtube\.com\/oembed/);
});

test('youtube details without key surfaces the oEmbed error (no web fallback)', async () => {
  await withFetch(async (input) => {
    assert.match(String(input), /^https:\/\/www\.youtube\.com\/oembed/);
    return new Response('noembed', { status: 404 });
  }, async () => {
    await assert.rejects(
      () => callNativeTool('media', { platform: 'youtube', action: 'details', id: 'vid123' }, { env: {} }),
      /not valid JSON/,
    );
  });
});

test('youtube details: keyed auth failure fails closed', async () => {
  const options = { env: { YOUTUBE_API_KEY: 'k' } };
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/oembed')) return new Response('noembed', { status: 404 });
    return jsonResponse(JSON.stringify({ error: { message: 'forbidden' } }), 403);
  }, async () => {
    await assert.rejects(
      () => callNativeTool('media', { platform: 'youtube', action: 'details', id: 'vid123' }, options),
      /HTTP 403/,
    );
  });
});

// ── Python social CLIs run under the shared sanitized child environment ──

test('reach_status: OAuth backend id is reddit-oauth and cannot claim feed/saved', async () => {
  const oauthEnv = { PATH: '/nonexistent', REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'ua/1' };
  const search = await callNativeTool('reach_status', { family: 'social', action: 'search' }, { env: oauthEnv });
  const searchReddit = ((search.details as { channels: Array<Record<string, unknown>> }).channels).find((c) => c.name === 'reddit');
  assert.equal(searchReddit?.status, 'ok');
  assert.equal(searchReddit?.active_backend, 'reddit-oauth');
  for (const action of ['get_feed', 'get_saved']) {
    const result = await callNativeTool('reach_status', { family: 'social', action }, { env: oauthEnv });
    const reddit = ((result.details as { channels: Array<Record<string, unknown>> }).channels).find((c) => c.name === 'reddit');
    assert.equal(reddit?.status, 'off', `OAuth must not claim reddit ${action}`);
    assert.notEqual(reddit?.active_backend, 'reddit-oauth', `OAuth must not be active for ${action}`);
    assert.equal(reddit?.active_backend, null);
  }
});

test('video: unlisted registry candidates are never spawned (fail closed)', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'bili', '#!/bin/sh\necho \'{"items":[]}\'\n');
    await assert.rejects(
      () => callNativeTool('video', { platform: 'bilibili', action: 'transcript', id: 'x' }, { env: { PATH: dir } }),
      (err: unknown) => err instanceof Error && /No usable bilibili backend/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('video: legacy bilibili video spelling is unsupported_action', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'bili', '#!/bin/sh\necho \'{"items":[]}\'\n');
    await assert.rejects(
      () => callNativeTool('video', { platform: 'bilibili', action: 'video', id: 'x' }, { env: { PATH: dir } }),
      (err: unknown) => err instanceof Error && err.name === 'SocialError' && /Unsupported bilibili action: video/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OPENCLI_* reach only the opencli child; Python CLIs get the sanitized environment', async () => {
  const dir = await withExecutableDir();
  try {
    // twitter-cli (Python) and xhs-cli (Python) both spawn under
    // buildPythonChildEnvironment(): fakes capture their env to a file.
    await writeShim(dir, 'twitter', `#!/bin/sh\n/usr/bin/env | /usr/bin/sort > ${join(dir, 'twitter.env')}\necho '[{"id":"1","text":"t"}]'\n`);
    // opencli-xiaohongshu is preferred over xhs-cli: the shim records its
    // environment, then fails retryably so xhs-cli serves the request.
    await writeShim(dir, 'opencli', `#!/bin/sh\n/usr/bin/env | /usr/bin/sort > ${join(dir, 'opencli.env')}\nexit 1\n`);
    await writeShim(dir, 'xhs', `#!/bin/sh\n/usr/bin/env | /usr/bin/sort > ${join(dir, 'xhs.env')}\necho '{"items":[]}'\n`);

    const env = {
      PATH: dir, OPENCLI_HOST: 'cli.example', OPENCLI_PORT: '9222', OPENCLI_TOKEN: 'opencli-secret',
      REDDIT_COOKIE: 'cookie-secret', GITHUB_TOKEN: 'github-secret',
    };
    const twitter = await callNativeTool('social', { platform: 'twitter', action: 'search', query: 'test' }, { env });
    assert.equal((twitter.details as { backend?: string }).backend, 'twitter-cli');
    const twitterEnv = await readFile(join(dir, 'twitter.env'), 'utf8');
    assert.doesNotMatch(twitterEnv, /OPENCLI_TOKEN/, 'twitter-cli must not receive OPENCLI_*');
    assert.doesNotMatch(twitterEnv, /OPENCLI_HOST/);
    assert.doesNotMatch(twitterEnv, /REDDIT_COOKIE/);
    assert.doesNotMatch(twitterEnv, /GITHUB_TOKEN/);
    assert.match(twitterEnv, new RegExp(`PATH=${dir}`));

    // xhs-cli search emits an empty item list after the preferred
    // opencli-xiaohongshu plan fails; the opencli child gets OPENCLI_*
    // while the Python xhs-cli child gets the sanitized environment.
    const xhs = await callNativeTool('social', { platform: 'xiaohongshu', action: 'search', query: 'test' }, { env });
    assert.equal((xhs.details as { backend?: string }).backend, 'xhs-cli');
    const opencliEnv = await readFile(join(dir, 'opencli.env'), 'utf8');
    assert.match(opencliEnv, /OPENCLI_HOST=cli\.example/);
    assert.match(opencliEnv, /OPENCLI_PORT=9222/);
    assert.match(opencliEnv, /OPENCLI_TOKEN=opencli-secret/);
    assert.doesNotMatch(opencliEnv, /REDDIT_COOKIE/);
    assert.doesNotMatch(opencliEnv, /GITHUB_TOKEN/);
    const xhsEnv = await readFile(join(dir, 'xhs.env'), 'utf8');
    assert.doesNotMatch(xhsEnv, /OPENCLI_TOKEN/, 'xhs.env must not receive OPENCLI_*');
    assert.doesNotMatch(xhsEnv, /OPENCLI_HOST/);
    assert.doesNotMatch(xhsEnv, /OPENCLI_PORT/);
    assert.doesNotMatch(xhsEnv, /REDDIT_COOKIE/);
    assert.doesNotMatch(xhsEnv, /GITHUB_TOKEN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Probe env is capability-specific: only locale/path/proxy base plus the
// probed command's own needs (OPENCLI_* for opencli, cookie keys for mapped
// cookie consumers). Unrelated API keys never reach a probe subprocess. ──

test('probe env is capability-specific per command', () => {
  const parent = {
    PATH: '/x', HOME: '/h',
    OPENCLI_HOST: 'cli.example', OPENCLI_PORT: '9222', OPENCLI_TOKEN: 'opencli-secret',
    GITHUB_TOKEN: 'github-secret', BRAVE_API_KEY: 'brave-secret', TAVILY_API_KEY: 'tavily-secret',
    REDDIT_COOKIE: 'cookie-secret',
  };
  const twitterEnv = externalEnvironment('twitter', parent);
  assert.equal(twitterEnv.PATH, '/x');
  assert.equal(twitterEnv.HOME, '/h');
  for (const key of ['OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN', 'GITHUB_TOKEN', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'REDDIT_COOKIE']) {
    assert.equal(twitterEnv[key], undefined, `twitter probe must not receive ${key}`);
  }
  const opencliEnv = externalEnvironment('opencli', parent);
  assert.equal(opencliEnv.OPENCLI_HOST, 'cli.example');
  assert.equal(opencliEnv.OPENCLI_PORT, '9222');
  assert.equal(opencliEnv.OPENCLI_TOKEN, 'opencli-secret');
  for (const key of ['GITHUB_TOKEN', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'REDDIT_COOKIE']) {
    assert.equal(opencliEnv[key], undefined, `opencli probe must not receive ${key}`);
  }
  const rdtEnv = externalEnvironment('rdt', parent);
  for (const key of ['OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN', 'GITHUB_TOKEN', 'BRAVE_API_KEY', 'REDDIT_COOKIE']) {
    assert.equal(rdtEnv[key], undefined, `rdt probe must not receive ${key}`);
  }
});

// ── Stage 3 media routing: keyed-only search/hot, legacy rejection, env isolation, transcripts ──

test('youtube search/hot without key fail closed (never scrape)', async () => {
  await assert.rejects(
    () => callNativeTool('video', { platform: 'youtube', action: 'search', query: 'cats' }, { env: { PATH: '/nonexistent' } }),
    /YOUTUBE_API_KEY/,
  );
  await assert.rejects(
    () => callNativeTool('video', { platform: 'youtube', action: 'hot' }, { env: { PATH: '/nonexistent' } }),
    /YOUTUBE_API_KEY/,
  );
});

test('media legacy subtitle spelling is unsupported_action with no echo', async () => {
  for (const platform of ['youtube', 'bilibili']) {
    await assert.rejects(
      () => callNativeTool('video', { platform, action: 'subtitle', query: 'super-secret-query-value' }, { env: { PATH: '/nonexistent' } }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(`Unsupported ${platform} action: subtitle`));
        assert.doesNotMatch(err.message, /super-secret-query-value/);
        return true;
      },
    );
  }
});

test('media unsupported action echo is capped at 32 chars', async () => {
  const longAction = `subtitle-${'x'.repeat(100)}`;
  await assert.rejects(
    () => callNativeTool('video', { platform: 'youtube', action: longAction, query: 'q' }, { env: { PATH: '/nonexistent' } }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(longAction), 'message must not echo the unbounded action value');
      assert.ok(err.message.includes(longAction.slice(0, 32)), 'message keeps the capped 32-char prefix for identification');
      return true;
    },
  );
});

test('video: bilibili search normalizes payloads with no raw stdout passthrough', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'bili', '#!/bin/sh\necho \'{"items":[{"bvid":"BV1xx411c7mD","title":"Bili Video","author":"uploader","play":123}]}\'\n');
    const result = await callNativeTool('video', { platform: 'bilibili', action: 'search', query: 'test' }, { env: { PATH: dir } });
    const details = result.details as Record<string, unknown>;
    assert.equal(details.backend, 'bili-cli');
    assert.ok(!('stdout' in details) && !('stderr' in details), 'success details must not carry raw CLI output');
    assert.match(JSON.stringify(result), /Bili Video/);
    assert.match(JSON.stringify(result), /bilibili:video:BV1xx411c7mD/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('video: bilibili child env is sanitized (no OPENCLI_*, no secrets)', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'bili', `#!/bin/sh\n/usr/bin/env | /usr/bin/sort > ${join(dir, 'bili.env')}\necho '{"items":[]}'\n`);
    const env = {
      PATH: dir, OPENCLI_HOST: 'cli.example', OPENCLI_PORT: '9222', OPENCLI_TOKEN: 'opencli-secret',
      REDDIT_COOKIE: 'cookie-secret', GITHUB_TOKEN: 'github-secret', YOUTUBE_API_KEY: 'yt-secret',
    };
    await callNativeTool('video', { platform: 'bilibili', action: 'search', query: 'test' }, { env });
    const captured = await readFile(join(dir, 'bili.env'), 'utf8');
    assert.doesNotMatch(captured, /OPENCLI_TOKEN/);
    assert.doesNotMatch(captured, /OPENCLI_HOST/);
    assert.doesNotMatch(captured, /OPENCLI_PORT/);
    assert.doesNotMatch(captured, /REDDIT_COOKIE/);
    assert.doesNotMatch(captured, /GITHUB_TOKEN/);
    assert.doesNotMatch(captured, /YOUTUBE_API_KEY/);
    assert.doesNotMatch(captured, /cookie-secret/);
    assert.match(captured, new RegExp(`PATH=${dir}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('video: stored bilibili cookies derive BILIBILI_* vars for the bili child', async () => {
  const dir = await withExecutableDir();
  try {
    await writeCookieState('bilibili', [
      { name: 'SESSDATA', value: 'sess-secret-value', domain: '.bilibili.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'bili_jct', value: 'csrf-value', domain: '.bilibili.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');
    await writeShim(dir, 'bili', `#!/bin/sh\n/usr/bin/env | /usr/bin/sort > ${join(dir, 'bili.env')}\necho '{"items":[]}'\n`);
    // Hermetic on Windows: resolveCliCommand reads process.env.PATH (not the
    // child env), so the shim dir must be on the real PATH during the call.
    await withShimmedPath(dir, () => callNativeTool('video', { platform: 'bilibili', action: 'search', query: 'test' }, { env: { PATH: dir, PI_SEARCH_STATE_DIR: dir } }));
    const captured = await readFile(join(dir, 'bili.env'), 'utf8');
    assert.match(captured, /BILIBILI_SESSDATA=sess-secret-value/);
    assert.match(captured, /BILIBILI_CSRF=csrf-value/);
    assert.match(captured, /BILIBILI_COOKIE=/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('video: bilibili transcript runs opencli with OPENCLI_* and no secrets', async () => {
  const dir = await withExecutableDir();
  try {
    await writeShim(dir, 'bili', FAIL_SHIM);
    await writeShim(dir, 'opencli', `#!/bin/sh\n/usr/bin/env | /usr/bin/sort > ${join(dir, 'opencli.env')}\necho '[{"start":0,"duration":2.5,"text":"hello world"}]'\n`);
    const env = {
      PATH: dir, OPENCLI_HOST: 'cli.example', OPENCLI_PORT: '9222', OPENCLI_TOKEN: 'opencli-secret',
      REDDIT_COOKIE: 'cookie-secret', GITHUB_TOKEN: 'github-secret',
    };
    // Hermetic on Windows: resolveCliCommand reads process.env.PATH (not the
    // child env), so the shim dir must be on the real PATH during the call.
    // Secret-leakage assertions below are unchanged and still meaningful: the
    // .cmd twin dumps the real child env via `set`.
    const result = await withShimmedPath(dir, () => callNativeTool('video', { platform: 'bilibili', action: 'transcript', id: 'BV1xx411c7mD' }, { env }));
    assert.equal((result.details as { backend?: string }).backend, 'OpenCLI');
    const items = (result.details as { items?: Array<{ kind?: string; segments?: unknown[] }> }).items;
    assert.equal(items?.[0]?.kind, 'video_transcript');
    assert.equal(items?.[0]?.segments?.length, 1);
    const captured = await readFile(join(dir, 'opencli.env'), 'utf8');
    assert.match(captured, /OPENCLI_HOST=cli\.example/);
    assert.match(captured, /OPENCLI_PORT=9222/);
    assert.match(captured, /OPENCLI_TOKEN=opencli-secret/);
    assert.doesNotMatch(captured, /REDDIT_COOKIE/);
    assert.doesNotMatch(captured, /GITHUB_TOKEN/);
    assert.doesNotMatch(captured, /BILIBILI_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const TRANSCRIPT_WATCH_HTML = '<html><head></head><body><script>var ytInitialPlayerResponse = {"responseContext":{},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.googlevideo.com/api/timedtext?v=abc123&lang=en","name":{"runs":[{"text":"English"}]},"languageCode":"en"}]}}};</script></body></html>';
const TRANSCRIPT_XML = '<transcript><text start="0" dur="2.5">hello world</text><text start="2.5" dur="1.5">second line</text></transcript>';

test('youtube transcript: watch page captions to allowlisted timedtext, normalized', async () => {
  const fetched: string[] = [];
  await withFetch(async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith('https://www.youtube.com/watch')) {
      return new Response(TRANSCRIPT_WATCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.startsWith('https://www.googlevideo.com/')) {
      return new Response(TRANSCRIPT_XML, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('video', { platform: 'youtube', action: 'transcript', id: 'abc123' }, { env: {} });
    const details = result.details as { backend?: string; items?: Array<{ kind?: string; videoId?: string; segments?: Array<{ text?: string }> }> };
    assert.equal(details.backend, 'youtube-transcript');
    assert.equal(details.items?.[0]?.kind, 'video_transcript');
    assert.equal(details.items?.[0]?.videoId, 'abc123');
    assert.deepEqual(details.items?.[0]?.segments?.map((segment) => segment.text), ['hello world', 'second line']);
  });
  assert.ok(fetched.some((url) => url.startsWith('https://www.youtube.com/watch?v=abc123')));
});

test('youtube transcript: non-allowlisted caption host rejected before fetch', async () => {
  const evilHtml = TRANSCRIPT_WATCH_HTML.replace('https://www.googlevideo.com/api/timedtext?v=abc123&lang=en', 'https://evil.example/captions?x=1');
  const fetched: string[] = [];
  await withFetch(async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith('https://www.youtube.com/watch')) {
      return new Response(evilHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    await assert.rejects(
      () => callNativeTool('video', { platform: 'youtube', action: 'transcript', id: 'abc123' }, { env: {} }),
      /not allowlisted/,
    );
  });
  assert.ok(!fetched.some((url) => url.includes('evil.example')), 'evil caption host must never be fetched');
});

test('youtube transcript: stored cookie sent to watch page only, never echoed', async () => {
  const dir = await withExecutableDir();
  try {
    await writeCookieState('youtube', [
      { name: 'SID', value: 'youtube-cookie-secret', domain: '.youtube.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');
    const cookies: Record<string, string> = {};
    await withFetch(async (input, init) => {
      const url = String(input);
      const header = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? '');
      if (url.startsWith('https://www.youtube.com/watch')) {
        cookies.watch = header;
        return new Response(TRANSCRIPT_WATCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.startsWith('https://www.googlevideo.com/')) {
        cookies.timedtext = header;
        return new Response(TRANSCRIPT_XML, { status: 200, headers: { 'content-type': 'application/xml' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await callNativeTool('video', { platform: 'youtube', action: 'transcript', id: 'abc123' }, { env: { PI_SEARCH_STATE_DIR: dir } });
      assert.equal((result.details as { backend?: string }).backend, 'youtube-transcript');
      assert.doesNotMatch(JSON.stringify(result), /youtube-cookie-secret/);
    });
    assert.match(cookies.watch ?? '', /SID=youtube-cookie-secret/);
    assert.equal(cookies.timedtext ?? '', '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('youtube transcript: segment output bounded', async () => {
  const many = Array.from({ length: 3100 }, (_, index) => `<text start="${index}" dur="1">line ${index}</text>`).join('');
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/watch')) {
      return new Response(TRANSCRIPT_WATCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.startsWith('https://www.googlevideo.com/')) {
      return new Response(`<transcript>${many}</transcript>`, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await callNativeTool('video', { platform: 'youtube', action: 'transcript', id: 'abc123' }, { env: {} });
    const items = (result.details as { items?: Array<{ segments?: unknown[] }> }).items;
    assert.equal(items?.[0]?.segments?.length, 3000);
    assert.match(JSON.stringify(result.details), /truncated/);
  });
});
