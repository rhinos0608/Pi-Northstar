import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNativeChildEnvironment } from '../../src/process/native-child-env.js';

test('sentinel secrets never leak into native child env', () => {
  const parentEnv: Record<string, string | undefined> = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    // Sentinels an operator env might carry — none may pass through.
    TAVILY_API_KEY: 'sentinel-tavily',
    GITHUB_TOKEN: 'sentinel-github',
    DIFFBOT_TOKEN: 'sentinel-diffbot',
    COOKIE_SESSION: 'sentinel-cookie',
    MY_API_KEY: 'sentinel-key',
    DB_PASSWORD: 'sentinel-password',
    BEARER_TOKEN: 'sentinel-bearer',
    HTTPS_PROXY: 'http://user:pass@proxy:8080',
    NODE_OPTIONS: '--inspect',
    PYTHONPATH: '/evil',
    GIT_CONFIG_COUNT: '1',
    LD_PRELOAD: '/evil.so',
  };
  const env = buildNativeChildEnvironment(parentEnv);
  for (const value of Object.values(env)) {
    assert.ok(!value.includes('sentinel'), `leaked sentinel: ${value}`);
    assert.ok(!value.includes('user:pass'), 'proxy credentials leaked');
  }
  assert.equal(env.TAVILY_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  // Benign essentials pass.
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/user');
});

test('narrower than python child env: no PI_ or proxy passthrough', () => {
  const env = buildNativeChildEnvironment({
    PATH: '/usr/bin',
    PI_SEARCH_SCRAPLING_ENABLED: '1',
    PI_SEARCH_EMBEDDING_PORT: '8080',
    HTTP_PROXY: 'http://proxy:8080',
    LANG: 'en_US.UTF-8',
  });
  assert.equal(env.PI_SEARCH_SCRAPLING_ENABLED, undefined);
  assert.equal(env.PI_SEARCH_EMBEDDING_PORT, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.LANG, 'en_US.UTF-8');
});

test('mirrors Windows Path casing for shim resolution', () => {
  const env = buildNativeChildEnvironment({ Path: 'C:\\Windows\\System32' });
  assert.equal(env.PATH, 'C:\\Windows\\System32');
});
