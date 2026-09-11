import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCliEnvironment } from '../src/cli-backend.js';
import { buildPythonChildEnvironment } from '../src/python-child-env.js';

const SENTINEL = 'SENTINEL_DIFFBOT_TOKEN_abc123xyz';

const DIFFBOT_KEYS = [
  'DIFFBOT_TOKEN',
  'DIFFBOT_SEARCH_SIZE',
  'DIFFBOT_ENHANCE_SIZE',
  'DIFFBOT_NLP_MAX_CHARS',
  'DIFFBOT_MAX_PROVIDERS',
  'DIFFBOT_FALLBACK_BUDGET',
] as const;

test('buildCliEnvironment forwards DIFFBOT_* core-path keys when set', () => {
  const env = buildCliEnvironment({
    DIFFBOT_TOKEN: SENTINEL,
    DIFFBOT_SEARCH_SIZE: '10',
    DIFFBOT_ENHANCE_SIZE: '1',
    DIFFBOT_NLP_MAX_CHARS: '100000',
    DIFFBOT_MAX_PROVIDERS: '3',
    DIFFBOT_FALLBACK_BUDGET: '3',
  });
  assert.equal(env.DIFFBOT_TOKEN, SENTINEL);
  assert.equal(env.DIFFBOT_SEARCH_SIZE, '10');
  assert.equal(env.DIFFBOT_ENHANCE_SIZE, '1');
  assert.equal(env.DIFFBOT_NLP_MAX_CHARS, '100000');
  assert.equal(env.DIFFBOT_MAX_PROVIDERS, '3');
  assert.equal(env.DIFFBOT_FALLBACK_BUDGET, '3');
});

test('buildCliEnvironment omits DIFFBOT_* keys when unset', () => {
  const env = buildCliEnvironment({ PATH: '/usr/bin' });
  for (const key of DIFFBOT_KEYS) {
    assert.equal(env[key], undefined, `${key} must be absent when unset`);
  }
});

test('sentinel: DIFFBOT_* never leak to unrelated child environments', () => {
  const parent = {
    PATH: '/usr/bin',
    DIFFBOT_TOKEN: SENTINEL,
    DIFFBOT_SEARCH_SIZE: '10',
    DIFFBOT_ENHANCE_SIZE: '1',
    DIFFBOT_NLP_MAX_CHARS: '100000',
    DIFFBOT_MAX_PROVIDERS: '3',
    DIFFBOT_FALLBACK_BUDGET: '3',
    DATABASE_URL: 'postgres://secret',
  };
  const pythonEnv = buildPythonChildEnvironment(parent);
  for (const key of DIFFBOT_KEYS) {
    assert.equal(pythonEnv[key], undefined, `python child env must not carry ${key}`);
  }
  const cliEnv = buildCliEnvironment(parent);
  assert.equal(cliEnv.DIFFBOT_TOKEN, SENTINEL, 'core Pi-Northstar CLI path carries the token');
  assert.equal(cliEnv.DATABASE_URL, undefined, 'unrelated secrets stay out of the CLI child env');
});
