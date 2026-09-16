import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeCookieState, type BrowserCookie } from '../../../src/chrome/cookie-jar.js';
import { EXTERNAL_TOOL_NAMES } from '../../../src/core/untrusted-content.js';
import { fetchAuthenticatedReadablePage } from '../../../src/web/access/web-access-auth-fetch.js';
import {
  parseWebAccessAuthProfiles,
  PI_FETCH_AUTH_PROFILES_ENV,
} from '../../../src/web/access/web-access-auth-contract.js';

const HTML = (body: string) =>
  `<html><head><title>Auth Article</title></head><body><article><p>${body}</p></article></body></html>`;

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 as const }];

function profileEnv(cache: 'session' | 'off' = 'off'): Record<string, string | undefined> {
  return {
    [PI_FETCH_AUTH_PROFILES_ENV]: JSON.stringify({
      yt: { provider: 'youtube', hosts: ['www.youtube.com'], cache },
    }),
  };
}

function jarCookies(): BrowserCookie[] {
  return [
    { name: 'session', value: 'yt-session-secret', domain: '.youtube.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'premium', value: 'yt-premium-secret', domain: '.youtube.com', path: '/premium', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'expired', value: 'yt-expired-secret', domain: '.youtube.com', path: '/', expires: 1, httpOnly: true, secure: true, sameSite: 'Lax' },
  ];
}

async function withJar(cookies: BrowserCookie[]): Promise<{ dir: string; env: Record<string, string | undefined> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-auth-fetch-'));
  const env = { ...profileEnv(), PI_SEARCH_STATE_DIR: dir };
  await writeCookieState('youtube', cookies, env, 'fixture');
  return { dir, env };
}

function htmlResponder(html: string, seen: Array<{ url: string; cookie: string | null }>) {
  return async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: input, cookie: headers.get('cookie') });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
}

test('HTTPS-only: http seed URLs reject before any fetch', async () => {
  const profiles = parseWebAccessAuthProfiles(profileEnv());
  let calls = 0;
  await assert.rejects(
    fetchAuthenticatedReadablePage('http://www.youtube.com/x', profiles.yt!, {
      env: {},
      fetchFn: (async () => { calls += 1; return new Response(''); }) as typeof fetch,
    }),
    /requires an HTTPS URL/,
  );
  assert.equal(calls, 0);
});

test('cookie attaches only on jar match; expired and foreign cookies excluded (T2, T7)', async () => {
  const { dir, env } = await withJar(jarCookies());
  // Foreign-provider cookies must never ride this profile's header.
  await writeCookieState('reddit', [
    { name: 'r', value: 'reddit-secret', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
  ], env, 'fixture');
  const profiles = parseWebAccessAuthProfiles(env);
  const seen: Array<{ url: string; cookie: string | null }> = [];
  try {
    const page = await fetchAuthenticatedReadablePage('https://www.youtube.com/article', profiles.yt!, {
      env,
      lookup: PUBLIC_LOOKUP,
      fetchFn: htmlResponder(HTML('authenticated body words'), seen),
    });
    assert.match(page.content, /authenticated body words/);
    assert.equal(seen.length, 1);
    const header = seen[0]!.cookie ?? '';
    assert.match(header, /yt-session-secret/);
    assert.ok(!header.includes('yt-expired-secret'), 'expired cookies never attach');
    assert.ok(!header.includes('reddit-secret'), 'foreign-provider cookies never attach');
    assert.ok(!header.includes('/premium'), 'path-scoped cookie stays home on mismatched path');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no cookie header when the jar is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-auth-fetch-empty-'));
  const env = { ...profileEnv(), PI_SEARCH_STATE_DIR: dir };
  const profiles = parseWebAccessAuthProfiles(env);
  const seen: Array<{ url: string; cookie: string | null }> = [];
  try {
    await fetchAuthenticatedReadablePage('https://www.youtube.com/article', profiles.yt!, {
      env,
      lookup: PUBLIC_LOOKUP,
      fetchFn: htmlResponder(HTML('public body'), seen),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.cookie, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cookie header recomputed per hop (path scoping follows the hop)', async () => {
  const { dir, env } = await withJar(jarCookies());
  const profiles = parseWebAccessAuthProfiles(env);
  const seen: Array<{ url: string; cookie: string | null }> = [];
  const fetchFn = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: input, cookie: headers.get('cookie') });
    if (input === 'https://www.youtube.com/free') {
      return new Response('', { status: 302, headers: { location: '/premium/video' } });
    }
    return new Response(HTML('premium body'), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const page = await fetchAuthenticatedReadablePage('https://www.youtube.com/free', profiles.yt!, {
      env,
      lookup: PUBLIC_LOOKUP,
      fetchFn: fetchFn as typeof fetch,
    });
    assert.match(page.content, /premium body/);
    assert.equal(seen.length, 2);
    assert.ok(!(seen[0]!.cookie ?? '').includes('yt-premium-secret'), 'hop 1 omits path-scoped cookie');
    assert.match(seen[1]!.cookie ?? '', /yt-premium-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PDF branch extracts local-only text; other types reject (D4)', async () => {
  const { dir, env } = await withJar([]);
  const profiles = parseWebAccessAuthProfiles(env);
  try {
    const pdf = await fetchAuthenticatedReadablePage('https://www.youtube.com/doc.pdf', profiles.yt!, {
      env,
      lookup: PUBLIC_LOOKUP,
      fetchFn: (async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200, headers: { 'content-type': 'application/pdf' },
      })) as typeof fetch,
      pdfExtractor: async () => ({ totalPages: 2, pages: ['hello pdf page one', 'page two text'] }),
    });
    assert.match(pdf.content, /hello pdf page one/);
    assert.equal(pdf.pdf?.totalPages, 2);
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/img.png', profiles.yt!, {
        env,
        lookup: PUBLIC_LOOKUP,
        fetchFn: (async () => new Response(new Uint8Array([1]), {
          status: 200, headers: { 'content-type': 'image/png' },
        })) as typeof fetch,
      }),
      /supports HTML and PDF content types only/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('byte ceiling enforced on announced and streamed bodies', async () => {
  const { dir, env } = await withJar([]);
  const profiles = parseWebAccessAuthProfiles(env);
  try {
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/big', profiles.yt!, {
        env,
        lookup: PUBLIC_LOOKUP,
        maxBytes: 10,
        fetchFn: (async () => new Response('0123456789abcdef', {
          status: 200, headers: { 'content-type': 'text/html', 'content-length': '16' },
        })) as typeof fetch,
      }),
      /exceeds the size limit/,
    );
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/x', profiles.yt!, { env, maxBytes: 0 }),
      /byte bound out of range/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('abort propagates; HTTP errors carry status but no URL or cookie (T8)', async () => {
  const { dir, env } = await withJar(jarCookies());
  const profiles = parseWebAccessAuthProfiles(env);
  try {
    // A pre-aborted signal fails closed at preflight: either the caller
    // reason or the DNS-abort message, never a fetch dispatch.
    const aborted = AbortSignal.abort(new Error('stop'));
    const seen: string[] = [];
    await assert.rejects(
      fetchAuthenticatedReadablePage('https://www.youtube.com/article', profiles.yt!, {
        env, lookup: PUBLIC_LOOKUP, signal: aborted, fetchFn: htmlResponder(HTML('x'), seen as never),
      }),
      /stop|aborted/i,
    );
    assert.equal(seen.length, 0);
    const failure = await fetchAuthenticatedReadablePage('https://www.youtube.com/secret-path?q=1', profiles.yt!, {
      env,
      lookup: PUBLIC_LOOKUP,
      fetchFn: (async () => new Response('no', { status: 403 })) as typeof fetch,
    }).then(() => 'resolved', (error: unknown) => String((error as Error).message));
    assert.match(failure, /HTTP 403/);
    assert.ok(!failure.includes('secret-path'), 'error text must not echo the URL');
    assert.ok(!failure.includes('yt-session-secret'), 'error text must not echo cookies');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('auth content stays untrusted-fenced downstream (T10)', () => {
  assert.ok((EXTERNAL_TOOL_NAMES as readonly string[]).includes('fetch'), 'fetch results keep untrusted fencing');
});
