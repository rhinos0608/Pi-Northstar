import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callNativeTool } from '../../../src/native-tools.js';
import { codexConfigured, mapCodexResults, readCodexCredentials } from '../../../src/web/providers/codex-search.js';
import { providerSummary } from '../../../src/setup/providers.js';

const CHATGPT_URL = 'https://chatgpt.com/backend-api/codex/alpha/search';

test('codex credential discovery: env token wins, auth file fallback, malformed/missing unconfigured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-atlas-codex-auth-'));
  try {
    // Env vars take precedence
    assert.deepEqual(
      readCodexCredentials({ CODEX_ACCESS_TOKEN: 'env-token', CODEX_ACCOUNT_ID: 'acct-1' }),
      { accessToken: 'env-token', accountId: 'acct-1' },
    );
    assert.ok(codexConfigured({ CODEX_ACCESS_TOKEN: 'env-token' }));
    // Blank env token falls through to the file
    assert.equal(readCodexCredentials({ CODEX_ACCESS_TOKEN: '  ', CODEX_HOME: join(dir, 'missing') }), undefined);

    // Valid auth file via CODEX_HOME
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'file-token', account_id: 'file-acct' } }));
    assert.deepEqual(readCodexCredentials({ CODEX_HOME: dir }), { accessToken: 'file-token', accountId: 'file-acct' });

    // account_id is optional
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'file-token' } }));
    assert.deepEqual(readCodexCredentials({ CODEX_HOME: dir }), { accessToken: 'file-token' });

    // Malformed JSON → unconfigured
    await writeFile(join(dir, 'auth.json'), '{not json');
    assert.equal(readCodexCredentials({ CODEX_HOME: dir }), undefined);

    // Missing tokens.access_token → unconfigured
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {} }));
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ other: 'x' }));
    assert.equal(readCodexCredentials({ CODEX_HOME: dir }), undefined);

    // Missing file → unconfigured
    assert.equal(readCodexCredentials({ CODEX_HOME: join(dir, 'nope') }), undefined);

    // Env token wins over malformed file
    assert.deepEqual(
      readCodexCredentials({ CODEX_HOME: dir, CODEX_ACCESS_TOKEN: 'env-token' }),
      { accessToken: 'env-token' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mapCodexResults accepts result objects with valid http/https URLs and trims fields', () => {
  assert.deepEqual(mapCodexResults({ results: [] }, 10), []);
  assert.deepEqual(mapCodexResults('nope', 10), []);
  const mapped = mapCodexResults({ results: [
    { url: '  https://example.com/a  ', title: '  A  ', snippet: '  snip  ' },
    { url: 'not-a-url', title: 'no' },
    { url: 'ftp://example.com/x', title: 'no' },
    { url: '', title: 'no' },
    42,
    null,
    { title: 'no url' },
    { url: 'http://example.com/b', title: 'B', snippet: '' },
  ] }, 10);
  assert.deepEqual(mapped, [
    { title: 'A', url: 'https://example.com/a', snippet: 'snip' },
    { title: 'B', url: 'http://example.com/b' },
  ]);
});

test('codex search posts fixed endpoint, bearer headers, query-only payload; output leaks no credentials', async () => {
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(input);
    observedInit = init;
    return new Response(JSON.stringify({ results: [
      { url: 'https://example.com/a', title: '  Trimmed title  ', snippet: ' Trimmed snippet ' },
      { url: 'relative/path', title: 'skip' },
      { url: 'https://example.com/b', title: 'B' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await callNativeTool('web_search', { query: 'hello world', limit: 10 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'codex', CODEX_ACCESS_TOKEN: 'tok-leak-me', CODEX_ACCOUNT_ID: 'acct-9' },
    });
    assert.equal(observedUrl, CHATGPT_URL);
    const headers = observedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer tok-leak-me');
    assert.equal(headers['ChatGPT-Account-ID'], 'acct-9');
    assert.equal(headers['User-Agent'], 'pi-northstar/0.3.0');
    const body = JSON.parse(String(observedInit?.body)) as Record<string, unknown>;
    assert.equal(body.model, 'gpt-4o');
    assert.deepEqual(body.commands, { search_query: [{ q: 'hello world' }] });
    assert.equal(typeof body.id, 'string');
    const details = JSON.stringify(result);
    const results = (result.details as { results: Array<{ url: string }> }).results;
    assert.equal(results.length, 2);
    assert.equal(results[0]?.url, 'https://example.com/a');
    assert.match(details, /Trimmed title/);
    assert.doesNotMatch(details, /tok-leak-me/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('codex participates in uniform RRF: no primary, richest donor wins representation', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(CHATGPT_URL)) {
      return new Response(JSON.stringify({ results: [
        { url: 'https://www.example.com/a?utm_source=codex', title: 'C-A', snippet: 'ca' },
        { url: 'https://example.com/c', title: 'C-C', snippet: 'cc' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return new Response(
        '<html><body>' +
        '<div><a class="result__a" href="https://example.com/a">DDG A</a>' +
        '<a class="result__snippet" href="https://example.com/a">ddg a</a></div>' +
        '<div><a class="result__a" href="https://example.com/d">DDG D</a>' +
        '<a class="result__snippet" href="https://example.com/d">ddg d</a></div>' +
        '</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const result = await callNativeTool('web_search', { query: 'x', limit: 20 }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'codex,duckduckgo', CODEX_ACCESS_TOKEN: 'tk' },
    });
    const details = result.details as {
      results: Array<{ url: string; snippet: string; source: string; contributors?: Array<{ backend: string; rank: number }> }>;
      fusion: { backends: string[]; primary?: string; failures: Array<{ backend: string; error: string }> };
    };
    assert.deepEqual(
      details.results.map((r) => r.url),
      ['https://example.com/a', 'https://example.com/c', 'https://example.com/d'],
    );
    assert.equal(details.results[0]?.snippet, 'ddg a', 'richest donor snippet wins; RRF score/order anchors unchanged');
    assert.equal(details.results[0]?.source, 'duckduckgo');
    assert.deepEqual(details.results[0]?.contributors, [{ backend: 'codex', rank: 1 }, { backend: 'duckduckgo', rank: 1 }]);
    assert.equal(details.fusion.primary, undefined, 'uniform RRF never assigns a primary');
    assert.deepEqual(details.fusion.backends.sort(), ['codex', 'duckduckgo']);
    assert.equal(details.fusion.failures.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('codex 5xx fails once without retry; survivors retained, body never in output', async () => {
  let chatgptCalls = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(CHATGPT_URL)) {
      chatgptCalls++;
      return new Response('{"error":"internal-secret-detail"}', { status: 500 });
    }
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return new Response(
        '<html><body><div><a class="result__a" href="https://example.com/ddg">D</a>' +
        '<a class="result__snippet" href="https://example.com/ddg">ddg only</a></div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const result = await callNativeTool('web_search', { query: 'x' }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'codex,duckduckgo', CODEX_ACCESS_TOKEN: 'tk' },
    });
    const details = result.details as {
      results: Array<{ url: string }>;
      fusion: { backends: string[]; primary?: string; failures: Array<{ backend: string; error: string }> };
    };
    assert.deepEqual(details.fusion.backends, ['duckduckgo']);
    assert.equal(details.fusion.primary, undefined);
    assert.equal(details.results[0]?.url, 'https://example.com/ddg');
    assert.equal(details.fusion.failures.length, 1);
    assert.equal(details.fusion.failures[0]?.backend, 'codex');
    assert.match(details.fusion.failures[0]?.error ?? '', /HTTP 500/);
    assert.doesNotMatch(JSON.stringify(details), /internal-secret-detail/);
    assert.equal(chatgptCalls, 1, '5xx costs exactly one call: providers never retry');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('codex 401/403/429 are not retried', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      return new Response('denied', { status });
    };
    try {
      await assert.rejects(
        () => callNativeTool('web_search', { query: 'x' }, {
          env: { PI_SEARCH_WEB_BACKENDS: 'codex', CODEX_ACCESS_TOKEN: 'tk' },
        }),
        new RegExp(`HTTP ${status}`),
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.equal(calls, 1, `status ${status} must not be retried`);
  }
});

test('explicit override excludes codex unless listed; listed-but-unconfigured codex rejected', async () => {
  let chatgptCalls = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(CHATGPT_URL)) {
      chatgptCalls++;
      throw new Error('codex must not be called');
    }
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return new Response(
        '<html><body><div><a class="result__a" href="https://example.com/ddg">D</a>' +
        '<a class="result__snippet" href="https://example.com/ddg">d</a></div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    // Credentials available, but the explicit override does not list codex
    await callNativeTool('web_search', { query: 'x' }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo', CODEX_ACCESS_TOKEN: 'tk' },
    });
    assert.equal(chatgptCalls, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
  // Explicit override lists codex but it is not configured
  await assert.rejects(
    () => callNativeTool('web_search', { query: 'x' }, {
      env: { PI_SEARCH_WEB_BACKENDS: 'codex', CODEX_HOME: '/nonexistent-codex-home' },
    }),
    /not configured/,
  );
});

test('multi-url fetch reads explicit urls in input order with per-url isolation', async () => {
  const requestedPaths: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    return new Response(`<html><body><h1>Page ${url.pathname.slice(1).toUpperCase()}</h1><p>This page contains unique ${url.pathname === '/a' ? 'alpha' : 'beta'} material about ranking order.</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };

  try {
    // Crawl-from-search-source is deleted by the fetch clean break: callers
    // pass explicit urls (e.g. from web_search); each URL reads in order.
    await callNativeTool('fetch', {
      urls: ['https://example.com/a', 'https://example.com/b'],
      query: 'alpha beta',
      topK: 4,
    }, {
      env: { CODEX_ACCESS_TOKEN: 'tk', PI_SEARCH_EMBEDDING_ENABLED: '0', PI_SEARCH_WEB_BACKENDS: 'codex,duckduckgo' },
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    assert.deepEqual(requestedPaths, ['/a', '/b'], 'explicit urls read in input order with per-url isolation');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('provider status reports codex configured via auth file without leaking the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-atlas-codex-status-'));
  try {
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'file-secret-token-xyz' } }));
    const summary = providerSummary({ CODEX_HOME: dir });
    const codex = summary.find((p) => p.provider === 'codex');
    assert.ok(codex, 'codex provider must be present');
    assert.equal(codex?.configured, true);
    assert.equal(codex?.loginFlow, 'cli_login');
    assert.deepEqual(codex?.keyNames, []);
    assert.doesNotMatch(JSON.stringify(summary), /file-secret-token-xyz/);

    const missing = providerSummary({ CODEX_HOME: join(dir, 'missing') });
    assert.equal(missing.find((p) => p.provider === 'codex')?.configured, false);
    // Env credentials mark configured too
    const envConfigured = providerSummary({ CODEX_ACCESS_TOKEN: 'env-val' });
    assert.equal(envConfigured.find((p) => p.provider === 'codex')?.configured, true);
    assert.doesNotMatch(JSON.stringify(envConfigured), /env-val/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codex search cancellation propagates', async () => {
  const controller = new AbortController();
  controller.abort();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (init?.signal?.aborted) {
      rejectAbort();
      return;
    }
    init?.signal?.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    await assert.rejects(
      () => callNativeTool('web_search', { query: 'x' }, {
        env: { PI_SEARCH_WEB_BACKENDS: 'codex', CODEX_ACCESS_TOKEN: 'tk' },
        signal: controller.signal,
      }),
      /aborted/i,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});