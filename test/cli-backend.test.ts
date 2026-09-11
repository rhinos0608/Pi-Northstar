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

test('buildCliEnvironment drops NODE_OPTIONS (CLI child sets --import tsx explicitly)', () => {
  const env = buildCliEnvironment({ PATH: '/usr/bin', NODE_OPTIONS: '--import evil.mjs --require pwn' });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

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

test('buildCliEnvironment forwards FIRECRAWL/JINA keys and web selection config when set', () => {
  const env = buildCliEnvironment({
    FIRECRAWL_API_KEY: 'SENTINEL_FIRECRAWL_abc123xyz',
    JINA_API_KEY: 'SENTINEL_JINA_abc123xyz',
    PI_SEARCH_WEB_BACKENDS: 'exa,tavily',
    PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS: '12000',
    PI_SEARCH_NATIVE_SUMMARIES: '1',
    PI_SEARCH_NATIVE_ANSWERS: '0',
    PI_SEARCH_KG_ENRICHMENT: '1',
    PI_SEARCH_EXTERNAL_FETCH: '1',
    PI_SEARCH_FETCH_BACKENDS: 'firecrawl,jina',
    PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS: '15000',
  });
  assert.equal(env.FIRECRAWL_API_KEY, 'SENTINEL_FIRECRAWL_abc123xyz');
  assert.equal(env.JINA_API_KEY, 'SENTINEL_JINA_abc123xyz');
  assert.equal(env.PI_SEARCH_WEB_BACKENDS, 'exa,tavily');
  assert.equal(env.PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS, '12000');
  assert.equal(env.PI_SEARCH_NATIVE_SUMMARIES, '1');
  assert.equal(env.PI_SEARCH_NATIVE_ANSWERS, '0');
  assert.equal(env.PI_SEARCH_KG_ENRICHMENT, '1');
  assert.equal(env.PI_SEARCH_EXTERNAL_FETCH, '1');
  assert.equal(env.PI_SEARCH_FETCH_BACKENDS, 'firecrawl,jina');
  assert.equal(env.PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS, '15000');
});

test('buildCliEnvironment omits FIRECRAWL/JINA keys when unset', () => {
  const env = buildCliEnvironment({ PATH: '/usr/bin' });
  assert.equal(env.FIRECRAWL_API_KEY, undefined, 'FIRECRAWL_API_KEY must be absent when unset');
  assert.equal(env.JINA_API_KEY, undefined, 'JINA_API_KEY must be absent when unset');
});

test('sentinel: FIRECRAWL/JINA keys never leak to the python child env', () => {
  const parent = {
    PATH: '/usr/bin',
    FIRECRAWL_API_KEY: 'SENTINEL_FIRECRAWL_abc123xyz',
    JINA_API_KEY: 'SENTINEL_JINA_abc123xyz',
  };
  const pythonEnv = buildPythonChildEnvironment(parent);
  assert.equal(pythonEnv.FIRECRAWL_API_KEY, undefined, 'python child env must not carry FIRECRAWL_API_KEY');
  assert.equal(pythonEnv.JINA_API_KEY, undefined, 'python child env must not carry JINA_API_KEY');
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

test('buildCliEnvironment forwards PI_SEARCH_WEB_AGENT_TIMEOUT_MS when set', () => {
  const env = buildCliEnvironment({ PI_SEARCH_WEB_AGENT_TIMEOUT_MS: '60000' });
  assert.equal(env.PI_SEARCH_WEB_AGENT_TIMEOUT_MS, '60000');
});

test('buildCliEnvironment forwards TAVILY_RESEARCH_MODEL when set, omits when unset', () => {
  assert.equal(buildCliEnvironment({ TAVILY_RESEARCH_MODEL: 'mini' }).TAVILY_RESEARCH_MODEL, 'mini');
  assert.equal(buildCliEnvironment({ PATH: '/usr/bin' }).TAVILY_RESEARCH_MODEL, undefined);
});
