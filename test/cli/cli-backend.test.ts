import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendCliStdout, buildCliEnvironment, createCliStdoutAccumulator, mapCliToolToCommandId } from '../../src/cli/cli-backend.js';
import { buildPythonChildEnvironment } from '../../src/process/python-child-env.js';

const SENTINEL = 'SENTINEL_DIFFBOT_TOKEN_abc123xyz';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function runCompiledWorker(request: unknown): Promise<{ code: number | null; output: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'dist/cli/worker.js')], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, output: JSON.parse(stdout) as Record<string, unknown> });
      } catch (error) {
        reject(new Error(`worker output invalid: ${String(error)}; stderr=${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

test('parent maps supported tools to canonical command ids and rejects unsupported calls', () => {
  assert.equal(mapCliToolToCommandId('web_search', { query: 'q' }), 'search.web');
  assert.equal(mapCliToolToCommandId('fetch', { url: 'https://example.com' }), 'fetch.read');
  assert.equal(mapCliToolToCommandId('media', { action: 'details', id: 'abc' }), 'media.details');
  assert.throws(() => mapCliToolToCommandId('video', { action: 'details', id: 'abc' }), /does not support/);
  assert.throws(() => mapCliToolToCommandId('github', { action: 'unknown' }), /does not support/);
});

test('compiled worker accepts closed canonical request and preserves handler result', async () => {
  const result = await runCompiledWorker({ commandId: 'fetch.read', args: {} });
  assert.equal(result.code, 0);
  assert.equal(result.output.ok, true);
  assert.equal((result.output.data as Record<string, unknown>).code, 'invalid_input');
});

test('compiled worker rejects unexpected request keys', async () => {
  const result = await runCompiledWorker({ commandId: 'fetch.read', args: {}, extra: true });
  assert.equal(result.code, 1);
  assert.equal((result.output.error as Record<string, unknown>).code, 'invalid_worker_request');
});

test('compiled worker rejects the retired raw-tool protocol', async () => {
  const result = await runCompiledWorker({ command: 'call', tool: 'github', args: { action: 'nope' } });
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, {
    ok: false,
    error: { code: 'invalid_worker_request', message: 'Invalid worker request.' },
  });
});

const DIFFBOT_KEYS = [
  'DIFFBOT_TOKEN',
  'DIFFBOT_SEARCH_SIZE',
  'DIFFBOT_ENHANCE_SIZE',
  'DIFFBOT_NLP_MAX_CHARS',
  'DIFFBOT_MAX_PROVIDERS',
  'DIFFBOT_FALLBACK_BUDGET',
] as const;

test('buildCliEnvironment appends the standard user tool bin after PATH for social CLI discovery', () => {
  const env = buildCliEnvironment({ PATH: '/usr/bin:/bin', HOME: '/Users/test' }, 'social');
  assert.equal(env.PATH, '/usr/bin:/bin:/Users/test/.local/bin');
});

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
  }, 'kg');
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
  }, 'fetch');
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
  const cliEnv = buildCliEnvironment(parent, 'kg');
  assert.equal(cliEnv.DIFFBOT_TOKEN, SENTINEL, 'kg tool child carries the token');
  const bare = buildCliEnvironment(parent);
  assert.equal(bare.DIFFBOT_TOKEN, undefined, 'no-toolName call denies credentials (deny-by-default)');
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

const NEW_PROVIDER_KEYS = [
  'PARALLEL_API_KEY',
  'TINYFISH_API_KEY',
  'QUERIT_API_KEY',
  'VALYU_API_KEY',
  'BOCHA_API_KEY',
  'XCRAWL_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'BRIGHTDATA_API_KEY',
  'BRIGHTDATA_SERP_ZONE',
  'SERPAPI_KEY',
  'SERPER_API_KEY',
] as const;

test('buildCliEnvironment forwards new provider keys when set (sentinel)', () => {
  const parent: Record<string, string> = { PATH: '/usr/bin' };
  for (const key of NEW_PROVIDER_KEYS) parent[key] = `SENTINEL_${key}_abc123xyz`;
  const env = buildCliEnvironment(parent, 'web_search');
  for (const key of NEW_PROVIDER_KEYS) {
    assert.equal(env[key], `SENTINEL_${key}_abc123xyz`, `${key} must be forwarded to the CLI child`);
  }
});

test('buildCliEnvironment omits new provider keys when unset', () => {
  const env = buildCliEnvironment({ PATH: '/usr/bin' });
  for (const key of NEW_PROVIDER_KEYS) {
    assert.equal(env[key], undefined, `${key} must be absent when unset`);
  }
});

test('appendCliStdout head-caps at limit and flags truncation (no tail-slice JSON break)', () => {
  const acc = createCliStdoutAccumulator();
  assert.equal(appendCliStdout(acc, '{"ok":true,"data":"', 20), false);
  assert.equal(appendCliStdout(acc, 'x'.repeat(50), 20), true);
  assert.equal(acc.truncated, true);
  assert.equal(acc.text.length, 20);
  assert.ok(acc.text.startsWith('{"ok":true'), 'head kept, not tail');
  // Further chunks drain-discarded, flag sticks.
  assert.equal(appendCliStdout(acc, 'more'), true);
  assert.equal(acc.text.length, 20);
});

test('appendCliStdout exact-limit append does not flag truncation', () => {
  const acc = createCliStdoutAccumulator();
  assert.equal(appendCliStdout(acc, '12345', 5), false);
  assert.equal(acc.truncated, false);
  assert.equal(appendCliStdout(acc, 'x', 5), true);
  assert.equal(acc.truncated, true);
});

test('sentinel: new provider keys never leak to the python child env', () => {
  const parent: Record<string, string> = { PATH: '/usr/bin' };
  for (const key of NEW_PROVIDER_KEYS) parent[key] = `SENTINEL_${key}_abc123xyz`;
  const pythonEnv = buildPythonChildEnvironment(parent);
  for (const key of NEW_PROVIDER_KEYS) {
    assert.equal(pythonEnv[key], undefined, `python child env must not carry ${key}`);
  }
});

test('buildCliEnvironment forwards DIFFBOT_TOKEN to the graph child for DQL; web_search scope unchanged', () => {
  const scoped = buildCliEnvironment({ DIFFBOT_TOKEN: SENTINEL }, 'graph');
  assert.equal(scoped.DIFFBOT_TOKEN, SENTINEL);
  const unrelated = buildCliEnvironment({ DIFFBOT_TOKEN: SENTINEL }, 'web_search');
  assert.equal(unrelated.DIFFBOT_TOKEN, SENTINEL, 'web_search keeps its existing DIFFBOT_TOKEN scope');
});
