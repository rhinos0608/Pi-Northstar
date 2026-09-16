import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COOKIE_ENV_KEYS, cookieAuthEnvironment, cookieEnvKeysForProvider, cookieHeaderForUrl, filterCookiesForDomains, importCookiesFromDefaultBrowser, writeCookieState, type BrowserCookie } from '../../src/chrome/cookie-jar.js';

const cookies: BrowserCookie[] = [
  { name: 'auth', value: 'secret-facebook', domain: '.facebook.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: 'other', value: 'secret-other', domain: '.example.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
];

test('filterCookiesForDomains keeps only provider domain suffixes', () => {
  const filtered = filterCookiesForDomains(cookies, ['facebook.com']);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.domain, '.facebook.com');
});

test('writeCookieState writes private storageState and omits values from summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-state-'));
  try {
    const summary = await writeCookieState('facebook', [cookies[0]!], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    assert.equal(summary.count, 1);
    assert.equal(summary.storagePath, join(dir, 'cookies', 'facebook.storageState.json'));
    assert.doesNotMatch(JSON.stringify(summary), /secret-facebook|auth/);

    const storage = JSON.parse(await readFile(summary.storagePath, 'utf8')) as { cookies: Array<{ value: string }> };
    assert.equal(storage.cookies[0]?.value, 'secret-facebook');

    if (process.platform !== 'win32') {
      assert.equal((await stat(join(dir, 'cookies'))).mode & 0o777, 0o700);
      assert.equal((await stat(summary.storagePath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cookieHeaderForUrl matches only the exact scoped host, path, and secure/expiry state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-routing-'));
  try {
    const env = { PI_SEARCH_STATE_DIR: dir } as Record<string, string | undefined>;
    await writeCookieState('reddit', [
      { name: 'session', value: 'domain-cookie', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'hostonly', value: 'host-only-cookie', domain: 'www.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'scoped', value: 'path-scoped', domain: '.reddit.com', path: '/r/x', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'expired', value: 'expired-cookie', domain: '.reddit.com', path: '/', expires: 1, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], env, 'fixture');

    // Domain-attribute cookie matches the domain and subdomains.
    assert.match(cookieHeaderForUrl('reddit', 'https://www.reddit.com/search.json', env) ?? '', /domain-cookie/);
    assert.match(cookieHeaderForUrl('reddit', 'https://old.reddit.com/path', env) ?? '', /domain-cookie/);
    // Host-only cookie matches exactly its host.
    assert.match(cookieHeaderForUrl('reddit', 'https://www.reddit.com/search.json', env) ?? '', /host-only-cookie/);
    assert.doesNotMatch(cookieHeaderForUrl('reddit', 'https://old.reddit.com/path', env) ?? '', /host-only-cookie/);
    // Path scoping.
    assert.match(cookieHeaderForUrl('reddit', 'https://www.reddit.com/r/x/comments/1', env) ?? '', /path-scoped/);
    assert.doesNotMatch(cookieHeaderForUrl('reddit', 'https://www.reddit.com/other', env) ?? '', /path-scoped/);
    // Expired cookies are never included.
    assert.doesNotMatch(cookieHeaderForUrl('reddit', 'https://www.reddit.com/search.json', env) ?? '', /expired-cookie/);
    // Non-Reddit / other-provider hosts get nothing.
    assert.equal(cookieHeaderForUrl('reddit', 'https://example.com/', env), undefined);
    assert.equal(cookieHeaderForUrl('twitter', 'https://www.reddit.com/', env), undefined);
    // http scheme is refused outright.
    assert.equal(cookieHeaderForUrl('reddit', 'http://www.reddit.com/', env), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cookieAuthEnvironment never derives Twitter env from stored state (retired Pi-cookie path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-env-'));
  try {
    await writeCookieState('twitter', [
      { name: 'auth_token', value: 'tw-auth-secret', domain: '.x.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ct0', value: 'tw-ct0-secret', domain: '.x.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    assert.deepEqual(cookieAuthEnvironment('twitter', { PI_SEARCH_STATE_DIR: dir }), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cookieAuthEnvironment never derives Twitter or Xiaohongshu env even with fresh cookies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-expired-'));
  try {
    await writeCookieState('twitter', [
      { name: 'auth_token', value: 'expired-auth-secret', domain: '.x.com', path: '/', expires: 1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ct0', value: 'fresh-ct0-secret', domain: '.x.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');
    await writeCookieState('xiaohongshu', [
      { name: 'web_session', value: 'xhs-secret', domain: '.xiaohongshu.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], { PI_SEARCH_STATE_DIR: dir }, 'fixture');

    assert.deepEqual(cookieAuthEnvironment('twitter', { PI_SEARCH_STATE_DIR: dir }), {});
    assert.deepEqual(cookieAuthEnvironment('xiaohongshu', { PI_SEARCH_STATE_DIR: dir }), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cookieHeaderForUrl drops non-ByteString cookies instead of crashing fetch (ByteString repro)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-fffd-'));
  try {
    const env = { PI_SEARCH_STATE_DIR: dir } as Record<string, string | undefined>;
    // Synthetic fixture: lossy utf8 decode of a Chromium encrypted blob yields
    // U+FFFD, which fetch rejects as a ByteString at request time.
    await writeCookieState('reddit', [
      { name: 'session', value: '\uFFFDabc', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'token', value: 'valid-value', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], env, 'synthetic-fixture');

    const header = cookieHeaderForUrl('reddit', 'https://www.reddit.com/search.json?q=x', env);
    assert.ok(header);
    assert.doesNotMatch(header, /\uFFFD/);
    assert.match(header, /token=valid-value/);
    // The exact live failure mode must stay impossible at the fetch seam.
    assert.doesNotThrow(() => new Headers({ Cookie: header }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cookieAuthEnvironment drops non-ByteString cookies from derived env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-env-fffd-'));
  try {
    const env = { PI_SEARCH_STATE_DIR: dir } as Record<string, string | undefined>;
    await writeCookieState('reddit', [
      { name: 'session', value: '\uFFFDabc', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'token', value: 'valid-value', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], env, 'synthetic-fixture');

    const derived = cookieAuthEnvironment('reddit', env);
    assert.ok(derived.REDDIT_COOKIE);
    assert.doesNotMatch(derived.REDDIT_COOKIE, /\uFFFD/);
    assert.equal(derived.REDDIT_COOKIE, 'token=valid-value');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('default browser import handles large Chrome expires_utc integers', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('default browser import currently supports macOS only');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-sqlite-'));
  const binDir = join(dir, 'bin');
  const profileDir = join(dir, 'profile');
  const networkDir = join(profileDir, 'Network');
  const stateDir = join(dir, 'state');
  const previousPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(networkDir, { recursive: true });
    const securityPath = join(binDir, 'security');
    await writeFile(securityPath, '#!/bin/sh\necho fake-safe-storage-key\n');
    await chmod(securityPath, 0o700);
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;

    const db = new DatabaseSync(join(networkDir, 'Cookies'));
    db.exec('create table cookies (host_key text, name text, value text, encrypted_value blob, path text, expires_utc integer, is_secure integer, is_httponly integer, samesite integer)');
    db.prepare('insert into cookies values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('.reddit.com', 'session', 'large-expiry-token', null, '/', 13439400717159052n, 1, 1, 1);
    db.close();

    const result = await importCookiesFromDefaultBrowser({ BROWSER_PROFILE_DIR: profileDir, PI_SEARCH_STATE_DIR: stateDir }, { providers: ['reddit'], force: true });

    assert.equal(result.ok, true);
    assert.equal(result.results[0]?.status, 'imported');
    assert.equal(result.results[0]?.count, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('default browser import honors browser automation opt-out', async () => {
  const result = await importCookiesFromDefaultBrowser({ PI_SEARCH_BROWSER_AUTOMATION: '0' });

  assert.equal(result.ok, false);
  assert.match(result.message, /disabled/);
});

test('cookie registry covers only live cookie-consuming providers (reddit + bilibili + youtube)', () => {
  assert.deepEqual(Object.keys(COOKIE_ENV_KEYS).sort(), ['bilibili', 'reddit', 'youtube']);
  assert.deepEqual(cookieEnvKeysForProvider('youtube'), ['YOUTUBE_COOKIE']);
  assert.equal('twitter' in COOKIE_ENV_KEYS, false);
  assert.equal('xiaohongshu' in COOKIE_ENV_KEYS, false);
  assert.equal('xueqiu' in COOKIE_ENV_KEYS, false);
  assert.deepEqual(cookieEnvKeysForProvider('twitter'), []);
  assert.deepEqual(cookieEnvKeysForProvider('xiaohongshu'), []);
  assert.deepEqual(cookieEnvKeysForProvider('xueqiu'), []);
});

test('cookieAuthEnvironment derives YOUTUBE_COOKIE header from stored state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-youtube-'));
  try {
    const env = { PI_SEARCH_STATE_DIR: dir } as Record<string, string | undefined>;
    await writeCookieState('youtube', [
      { name: 'CONSENT', value: 'youtube-secret', domain: '.youtube.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Lax' },
    ], env, 'fixture');
    const derived = cookieAuthEnvironment('youtube', env);
    assert.equal(derived.YOUTUBE_COOKIE, 'CONSENT=youtube-secret');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeCookieState summary and meta never embed cookie values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cookie-redaction-'));
  try {
    const env = { PI_SEARCH_STATE_DIR: dir } as Record<string, string | undefined>;
    const summary = await writeCookieState('reddit', [
      { name: 'session', value: 'reddit-redact-me', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'token', value: 'reddit-token-redact-me', domain: '.reddit.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Lax' },
    ], env, 'fixture');
    assert.doesNotMatch(JSON.stringify(summary), /redact-me/);
    const metaRaw = await readFile(join(dir, 'cookies', 'reddit.meta.json'), 'utf8');
    assert.doesNotMatch(metaRaw, /redact-me/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('default browser import degrades on unsupported platforms', async (t) => {
  if (process.platform === 'darwin') {
    t.skip('macOS path may prompt for Keychain; covered by opt-out and writer tests');
    return;
  }

  const result = await importCookiesFromDefaultBrowser({});
  assert.equal(result.ok, false);
  assert.match(result.message, /macOS/);
});

test('auth fetch path uses per-hop jar headers only, never the derived CLI env (T7/T12)', async () => {
  // Static seam guard: web-access-auth-fetch may call cookieHeaderForUrl (per
  // hop, host/path/expiry scoped) but must never call cookieAuthEnvironment
  // (bulk derived env for CLI children). Companion grants in
  // chrome-profile-auth stay out of the fetch path entirely.
  const source = await readFile(new URL('../../src/web/access/web-access-auth-fetch.ts', import.meta.url), 'utf8');
  assert.match(source, /cookieHeaderForUrl/);
  // Comment lines may name the forbidden seam for documentation; code lines
  // must never reference it.
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /cookieAuthEnvironment/);
  assert.doesNotMatch(code, /chrome-profile-auth/);
});
