import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSearchBackend, resultToText } from '../src/backend.js';
import { buildCliEnvironment } from '../src/cli-backend.js';

test('createSearchBackend returns backend interface', () => {
  const backend = createSearchBackend({
    SEARCH_MCP_COMMAND: 'node',
    SEARCH_MCP_ARGS_JSON: '["server.js"]',
  });

  assert.equal(typeof backend.callTool, 'function');
  assert.equal(typeof backend.close, 'function');
});

test('import.meta.resolve("tsx") resolves to absolute file URL for CLI subprocess', () => {
  const resolved = import.meta.resolve('tsx');
  assert.ok(resolved.startsWith('file://'), `tsx must resolve to file:// URL, got: ${resolved}`);
  assert.ok(resolved.endsWith('loader.mjs'), `tsx must resolve to loader.mjs, got: ${resolved}`);
});

test('CliSearchBackend child process works from a foreign cwd', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cwd-'));
  const backend = createSearchBackend({});

  try {
    process.chdir(dir);
    const result = await backend.callTool('reach_status', { family: 'media' }, { timeout: 60_000 });
    assert.match(resultToText(result), /native-rss-atom/);
  } finally {
    process.chdir(originalCwd);
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildCliEnvironment forwards CODE* env overrides and blocks unrelated secrets', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/user',
    CODEX_ACCESS_TOKEN: 'codex-token-abc',
    CODEX_ACCOUNT_ID: 'acct-123',
    CODEX_HOME: '/tmp/codex-home',
    OTHER_SECRET_TOKEN: 'should-not-pass',
    UNRELATED_API_KEY: 'should-not-pass',
  });
  assert.equal(env.CODEX_ACCESS_TOKEN, 'codex-token-abc');
  assert.equal(env.CODEX_ACCOUNT_ID, 'acct-123');
  assert.equal(env.CODEX_HOME, '/tmp/codex-home');
  assert.equal(env.OTHER_SECRET_TOKEN, undefined);
  assert.equal(env.UNRELATED_API_KEY, undefined);
});

test('buildCliEnvironment forwards reach backend auth and override allowlist', () => {
  assert.deepEqual(buildCliEnvironment({
    PATH: '/usr/bin',
    TWITTER_AUTH_TOKEN: 'token',
    TWITTER_CT0: 'ct0',
    REDDIT_COOKIE: 'session=secret',
    TWITTER_BACKEND: 'OpenCLI',
    PI_SEARCH_REDDIT_BACKEND: 'rdt',
    HTTPS_PROXY: 'http://proxy.example',
    EXA_API_KEY: 'exa',
    SEARCH_MCP_CONFIG_PATH: '/tmp/config.json',
    PI_SEARCH_BROWSER_AUTOMATION: '0',
    BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    BROWSER_EXECUTABLE_PATH: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    DATABASE_URL: 'secret',
  }), {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.example',
    TWITTER_AUTH_TOKEN: 'token',
    TWITTER_CT0: 'ct0',
    REDDIT_COOKIE: 'session=secret',
    EXA_API_KEY: 'exa',
    SEARCH_MCP_CONFIG_PATH: '/tmp/config.json',
    PI_SEARCH_BROWSER_AUTOMATION: '0',
    BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    BROWSER_EXECUTABLE_PATH: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    TWITTER_BACKEND: 'OpenCLI',
    PI_SEARCH_REDDIT_BACKEND: 'rdt',
  });
});

test('buildCliEnvironment forwards REDDIT_COOKIE into the Pi-owned CLI but blocks unrelated secrets', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    REDDIT_COOKIE: 'session=reddit-cookie-secret',
    STRIPE_API_KEY: 'stripe-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    DATABASE_URL: 'postgres://u:p@db',
  });
  // REDDIT_COOKIE is allowed: it is the only path by which a logged-in Reddit
  // session reaches the Pi-owned CLI process for the native cookie fallback.
  assert.equal(env.REDDIT_COOKIE, 'session=reddit-cookie-secret');
  assert.equal(env.STRIPE_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test('buildCliEnvironment forwards TWITTER_COOKIE like REDDIT_COOKIE but blocks unrelated secrets', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    TWITTER_COOKIE: 'auth_token=tw-secret; ct0=tw-secret',
    STRIPE_API_KEY: 'stripe-secret',
  });
  assert.equal(env.TWITTER_COOKIE, 'auth_token=tw-secret; ct0=tw-secret');
  assert.equal(env.STRIPE_API_KEY, undefined);
});

test('buildCliEnvironment forwards PI_SEARCH_PLATFORM_WEB_FALLBACK opt-in flag', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    PI_SEARCH_PLATFORM_WEB_FALLBACK: '1',
    SEARCH_WEB_BACKENDS: 'duckduckgo',
    OTHER_SECRET_TOKEN: 'should-not-pass',
  });
  assert.equal(env.PI_SEARCH_PLATFORM_WEB_FALLBACK, '1');
  assert.equal(env.SEARCH_WEB_BACKENDS, 'duckduckgo');
  assert.equal(env.OTHER_SECRET_TOKEN, undefined);
});

test('CliSearchBackend: wall-clock timeout is a timeout failure, not AbortError', async () => {
  // A backend timeout must stay retry/fallback-eligible: it is not caller
  // cancellation, so it must reject with a timeout error, never AbortError.
  const backend = createSearchBackend({});
  try {
    await assert.rejects(
      backend.callTool('reach_status', { family: 'media' }, { timeout: 100 }),
      (err: unknown) => err instanceof Error
        && /timed out after 100ms/i.test(err.message)
        && err.name !== 'AbortError',
    );
  } finally {
    await backend.close();
  }
});
