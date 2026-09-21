import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSearchBackend } from '../src/backend.js';
import { buildCliEnvironment, CliSearchBackend } from '../src/cli/cli-backend.js';

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
    // 'fetch' maps to the canonical fetch.read command. An invalid URL is
    // rejected deterministically inside the child handler with no network.
    // Rejecting with the handler's invalid_input commandResult (instead of a mapping
    // or spawn error) proves the absolute worker entrypoint resolved and
    // executed while the cwd was foreign.
    const error = await backend.callTool('fetch', { url: 'notaurl' }, { timeout: 60_000 }).then(() => { throw new Error('expected fetch to reject'); }, (caught) => caught);
    assert.equal((error as { commandResult?: { error?: { code?: string } } }).commandResult?.error?.code, 'invalid_input');
  } finally {
    process.chdir(originalCwd);
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildCliEnvironment forwards CODE* env overrides to web_search and blocks unrelated secrets', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/user',
    CODEX_ACCESS_TOKEN: 'codex-token-abc',
    CODEX_ACCOUNT_ID: 'acct-123',
    CODEX_HOME: '/tmp/codex-home',
    OTHER_SECRET_TOKEN: 'should-not-pass',
    UNRELATED_API_KEY: 'should-not-pass',
  }, 'web_search');
  assert.equal(env.CODEX_ACCESS_TOKEN, 'codex-token-abc');
  assert.equal(env.CODEX_ACCOUNT_ID, 'acct-123');
  assert.equal(env.CODEX_HOME, '/tmp/codex-home');
  assert.equal(env.OTHER_SECRET_TOKEN, undefined);
  assert.equal(env.UNRELATED_API_KEY, undefined);
});

test('buildCliEnvironment forwards social backend auth but blocks Twitter/XHS cookie secrets', () => {
  assert.deepEqual(buildCliEnvironment({
    PATH: '/usr/bin',
    TWITTER_AUTH_TOKEN: 'token',
    TWITTER_CT0: 'ct0',
    TWITTER_COOKIE: 'auth_token=secret',
    XHS_COOKIE: 'session=secret',
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
  }, 'social'), {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.example',
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

test('buildCliEnvironment forwards REDDIT_COOKIE into the social child but blocks unrelated secrets', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    REDDIT_COOKIE: 'session=reddit-cookie-secret',
    STRIPE_API_KEY: 'stripe-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    DATABASE_URL: 'postgres://u:p@db',
  }, 'social');
  // REDDIT_COOKIE is allowed: it is the path by which a logged-in Reddit
  // session reaches the canonical social CLI child for the cookie fallback.
  assert.equal(env.REDDIT_COOKIE, 'session=reddit-cookie-secret');
  assert.equal(env.STRIPE_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test('buildCliEnvironment blocks TWITTER_COOKIE/TWITTER_AUTH_TOKEN like unrelated secrets', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    TWITTER_COOKIE: 'auth_token=tw-secret; ct0=tw-secret',
    TWITTER_AUTH_TOKEN: 'tw-secret',
    TWITTER_CT0: 'tw-secret',
    REDDIT_COOKIE: 'session=reddit-cookie-secret',
    STRIPE_API_KEY: 'stripe-secret',
  }, 'social');
  // Dead Twitter/XHS cookie plumbing: CLI children never consume
  // imported Pi cookie state, so these secrets must not reach the CLI child.
  assert.equal(env.TWITTER_COOKIE, undefined);
  assert.equal(env.TWITTER_AUTH_TOKEN, undefined);
  assert.equal(env.TWITTER_CT0, undefined);
  assert.equal(env.REDDIT_COOKIE, 'session=reddit-cookie-secret');
  assert.equal(env.STRIPE_API_KEY, undefined);
});

test('buildCliEnvironment forwards GH_TOKEN alongside GITHUB_TOKEN to the github child', () => {
  // github-contract accepts GITHUB_TOKEN ?? GH_TOKEN; the CLI child must
  // receive both spellings or GH_TOKEN-only operators lose auth in children.
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    GITHUB_TOKEN: 'ghp-token',
    GH_TOKEN: 'ghp-token-alias',
  }, 'github');
  assert.equal(env.GITHUB_TOKEN, 'ghp-token');
  assert.equal(env.GH_TOKEN, 'ghp-token-alias');
});

test('buildCliEnvironment drops PI_SEARCH_PLATFORM_WEB_FALLBACK and PI_SEARCH_AUTO_COOKIES', () => {
  const env = buildCliEnvironment({
    PATH: '/usr/bin',
    PI_SEARCH_PLATFORM_WEB_FALLBACK: '1',
    PI_SEARCH_AUTO_COOKIES: '1',
    SEARCH_WEB_BACKENDS: 'duckduckgo',
    OTHER_SECRET_TOKEN: 'should-not-pass',
  });
  assert.equal(env.PI_SEARCH_PLATFORM_WEB_FALLBACK, undefined);
  assert.equal(env.PI_SEARCH_AUTO_COOKIES, undefined);
  assert.equal(env.SEARCH_WEB_BACKENDS, undefined);
  assert.equal(env.OTHER_SECRET_TOKEN, undefined);
});

test('CliSearchBackend: wall-clock timeout is a timeout failure, not AbortError', async () => {
  // A backend timeout must stay retry/fallback-eligible: it is not caller
  // cancellation, so it must reject with a timeout error, never AbortError.
  // 'web_search' maps to canonical search.web so mapping succeeds; the
  // injected cliPath hangs deterministically until the wall-clock fires.
  const hangFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-hang.mjs');
  const backend = new CliSearchBackend({}, hangFixture);
  try {
    await assert.rejects(
      backend.callTool('web_search', { query: 'timeout determinism probe' }, { timeout: 100 }),
      (err: unknown) => err instanceof Error
        && /timed out after 100ms/i.test(err.message)
        && err.name !== 'AbortError',
    );
    // Contrast: caller cancellation after spawn still surfaces as AbortError.
    // Spawn is synchronous before promise return, so one event-loop turn
    // guarantees the hang child exists before abort; rejection settles via
    // child close, proving the termination path runs.
    const controller = new AbortController();
    const cancelled = backend.callTool('web_search', { query: 'cancel after spawn probe' }, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(
      cancelled,
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );
  } finally {
    await backend.close();
  }
});

test('buildCliEnvironment credential-scope matrix: status helpers get base only; social/feeds/media share presence keys', () => {
  const parent = {
    PATH: '/usr/bin',
    REDDIT_COOKIE: 'probe-reddit-cookie',
    GITHUB_TOKEN: 'probe-github-token',
    YOUTUBE_API_KEY: 'probe-youtube-key',
    PI_SEARCH_CHROME_BRIDGE_TOKEN: 'probe-bridge-token',
    STRIPE_API_KEY: 'probe-unrelated-secret',
  };
  for (const tool of ['reach_status', 'reach_setup']) {
    const env = buildCliEnvironment(parent, tool);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.REDDIT_COOKIE, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.YOUTUBE_API_KEY, undefined);
    assert.equal(env.PI_SEARCH_CHROME_BRIDGE_TOKEN, undefined);
    assert.equal(env.STRIPE_API_KEY, undefined);
  }
  for (const tool of ['social', 'feeds', 'media']) {
    const env = buildCliEnvironment(parent, tool);
    assert.equal(env.REDDIT_COOKIE, 'probe-reddit-cookie');
    assert.equal(env.GITHUB_TOKEN, 'probe-github-token');
    assert.equal(env.YOUTUBE_API_KEY, 'probe-youtube-key');
    assert.equal(env.PI_SEARCH_CHROME_BRIDGE_TOKEN, 'probe-bridge-token');
    assert.equal(env.STRIPE_API_KEY, undefined);
  }
});
