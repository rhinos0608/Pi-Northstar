import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { buildFetchRoute } from '../../src/web/web-fetch-route.js';
import { parseFetchReadArgs } from '../../src/commands/fetch-read-handler.js';
import { createFetchExecute, createWebSearchExecute } from '../../src/index.js';
import { WebSearchLedger } from '../../src/web/web-search-ledger.js';
import { getNativeFetchStore } from '../../src/native-fetch.js';
import type { DnsLookup } from '../../src/network-policy.js';

const PUBLIC_DNS: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
const LOOPBACK_DNS: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 as const }];

const ENV: Record<string, string | undefined> = {
  PI_SEARCH_WEB_BACKENDS: 'duckduckgo',
  PI_SEARCH_EMBEDDING_ENABLED: '0',
};

function htmlFor(title: string, body: string): string {
  return `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
}

function commandOf(result: unknown): Record<string, unknown> {
  const details = (result as { details?: { details?: Record<string, unknown> } }).details;
  const command = details?.details?.northstarCommand;
  assert.ok(command && typeof command === 'object', 'fetch must carry handler northstarCommand metadata nested once');
  return command as Record<string, unknown>;
}

let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

function throwFetch(): void {
  globalThis.fetch = (async () => {
    throw new Error('live network must not be touched');
  }) as typeof globalThis.fetch;
}

test('pi fetch executes canonical handler with surface pi + invocation id, zero backend by construction', async () => {
  throwFetch();
  const execute = createFetchExecute(ENV, {
    lookup: PUBLIC_DNS,
    fetchPageText: async () => htmlFor('Hello', 'Hello world page text for parity'),
  });
  // createFetchExecute takes (env, deps) only: no SearchBackend/MCP/native dispatcher exists by construction.
  assert.equal(createFetchExecute.length, 1, 'fetch execute factory takes env (+optional deps), never a backend client');
  const result = await execute('call-fetch-1', { request: { url: 'https://example.com/hello' } }, undefined);
  const command = commandOf(result);
  assert.equal(command.commandId, 'fetch.read');
  assert.equal(command.invocationId, 'call-fetch-1');
  assert.equal(command.requestedSurface, 'pi');
  assert.equal(command.resolvedSurface, 'fetch.read');
  assert.equal(command.outcome, 'success');
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.ok(text.includes('Hello world page text'), 'handler result text reaches caller');
});

test('single URL success generates responseId retrievable via Pi retrieve with zero network', async () => {
  const execute = createFetchExecute(ENV, {
    lookup: PUBLIC_DNS,
    fetchPageText: async () => htmlFor('Cached Page', 'cached content for no-network retrieval probe'),
  });
  const single = await execute('call-single-1', { url: 'https://example.com/cached' }, undefined);
  const singleDetails = (single.details as { details: Record<string, unknown> }).details;
  const responseId = singleDetails.responseId;
  assert.equal(typeof responseId, 'string');
  assert.ok((responseId as string).length > 0);

  // Retrieve through a fresh Pi execute with network rigged to throw.
  throwFetch();
  const retrieve = createFetchExecute(ENV);
  const out = await retrieve('call-retrieve-1', { responseId }, undefined);
  const command = commandOf(out);
  assert.equal(command.outcome, 'success');
  assert.equal((command.sources as Array<{ kind: string }>)[0]?.kind, 'internal');
  const outText = (out.content as Array<{ text: string }>)[0]!.text;
  assert.ok(outText.includes('cached content for no-network retrieval probe'));
});

test('multi URL mixed success/failure preserves input order + per-URL isolation; in-flight abort maps cancelled', async () => {
  const execute = createFetchExecute(ENV, {
    lookup: PUBLIC_DNS,
    fetchPageText: async (url: string) => {
      if (url.includes('/bad')) throw new Error('boom upstream failure');
      return htmlFor(url, `body for ${url}`);
    },
  });
  const multi = await execute('call-multi-1', { urls: ['https://example.com/good', 'https://example.com/bad'] }, undefined);
  const command = commandOf(multi);
  assert.equal(command.outcome, 'partial');
  assert.equal((command.error as { code?: string } | undefined)?.code, 'backend_unavailable');
  assert.equal((command.error as { retryable?: boolean } | undefined)?.retryable, true);
  assert.match(String((command.error as { message?: string } | undefined)?.message ?? ''), /boom upstream failure/);
  assert.equal(command.retryability, 'retryable');
  const multiDetails = (multi.details as { details: { urls: string[]; entries: Array<{ url: string; status: string; error?: Record<string, unknown> }>; responseId?: unknown } }).details;
  assert.deepEqual(multiDetails.urls, ['https://example.com/good', 'https://example.com/bad']);
  assert.deepEqual(
    multiDetails.entries.map((e) => [e.url, e.status]),
    [['https://example.com/good', 'ok'], ['https://example.com/bad', 'error']],
  );
  const firstError = multiDetails.entries[1]?.error;
  assert.equal(firstError?.code, 'backend_unavailable');
  assert.equal(firstError?.retryable, true);
  assert.match(String(firstError?.message ?? ''), /boom upstream failure/);
  assert.ok(String(firstError?.message ?? '').length <= 500);
  assert.deepEqual(Object.keys(firstError ?? {}).sort(), ['code', 'message', 'retryable']);
  assert.ok(!JSON.stringify(multiDetails).includes('"stack"'), 'no raw stack in output metadata');
  const text = (multi.content as Array<{ text: string }>)[0]!.text;
  assert.ok(text.indexOf('https://example.com/good') < text.indexOf('https://example.com/bad'), 'input order preserved');
  assert.ok(text.includes('Error: boom upstream failure'), 'per-URL isolation keeps sibling failure as entry');
  // Success entries stay cached under the returned handle.
  const mixedResponseId = multiDetails.responseId;
  assert.equal(typeof mixedResponseId, 'string');
  const mixedCached = await createFetchExecute(ENV)('call-multi-cache', { responseId: mixedResponseId }, undefined);
  assert.ok((mixedCached.content as Array<{ text: string }>)[0]!.text.includes('https://example.com/good'));

  // In-flight abort swallowed by per-URL isolation must still surface cancelled.
  const controller = new AbortController();
  const aborting = createFetchExecute(ENV, {
    lookup: PUBLIC_DNS,
    fetchPageText: async () => {
      controller.abort();
      return htmlFor('x', 'x');
    },
  });
  await assert.rejects(
    () => aborting('call-multi-abort', { urls: ['https://example.com/a', 'https://example.com/b'] }, controller.signal),
    (error: unknown) => {
      const cmd = (error as { commandResult?: { outcome: string; error?: { code: string } } }).commandResult;
      assert.ok(cmd, 'abort must attach commandResult');
      assert.equal(cmd.outcome, 'cancelled');
      assert.equal(cmd.error?.code, 'cancelled');
      return true;
    },
  );
});

test('sitemap success with injected DNS + fake Tavily map: ordered same-origin URLs + metadata', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    assert.ok(url.includes('api.tavily.com/map'), 'sitemap must dispatch Tavily map provider');
    void init;
    return new Response(
      JSON.stringify({ results: ['https://example.com/b', 'https://example.com/a', 'https://evil.com/x'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  const execute = createFetchExecute(
    { ...ENV, TAVILY_API_KEY: 'test-key' },
    { lookup: PUBLIC_DNS },
  );
  const out = await execute('call-sitemap-1', { url: 'https://example.com/docs/', siteMap: true, maxPages: 5 }, undefined);
  const command = commandOf(out);
  assert.equal(command.outcome, 'success');
  const details = (out.details as { details: Record<string, unknown> }).details;
  const siteMap = details.siteMap as { status: string; provider: string; baseUrl: string; urls: string[] };
  assert.equal(siteMap.provider, 'tavily');
  assert.equal(siteMap.baseUrl, 'https://example.com');
  assert.ok(siteMap.urls.every((u) => u.startsWith('https://example.com/')), 'same-origin only');
  assert.ok(!siteMap.urls.some((u) => u.includes('evil.com')), 'external rows dropped');
  assert.deepEqual(
    (command.sources as Array<{ locator?: string }>).map((s) => s.locator),
    siteMap.urls,
    'per-URL sources preserve order',
  );
  assert.ok(seen.length >= 1);
});

test('cached source_check from same parent responseId: zero network, internal cache provenance', async () => {
  const execute = createFetchExecute(ENV, {
    lookup: PUBLIC_DNS,
    fetchPageText: async () => htmlFor('Planets', 'The solar system has eight planets. Confirmed by observations.'),
  });
  const single = await execute('call-cache-1', { url: 'https://example.com/planets' }, undefined);
  const responseId = (single.details as { details: { responseId: string } }).details.responseId;

  throwFetch();
  const check = createFetchExecute(ENV);
  const out = await check('call-check-1', { responseId, claims: ['The solar system has eight planets.'] }, undefined);
  const command = commandOf(out);
  assert.equal(command.outcome, 'success');
  assert.equal((command.sources as Array<{ kind: string; locator?: string }>)[0]?.kind, 'internal');
  assert.equal((command.sources as Array<{ locator?: string }>)[0]?.locator, responseId);
  assert.equal(command.trust, 'external', 'cached evidence originated externally');
});

test('pi web_search responseId retrieves via pi fetch (shared parent store)', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const q = url.searchParams.get('q') ?? 'unknown';
    const slug = q.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return new Response(
      `<html><body><div><a class="result__a" href="https://example.com/${slug}">Title for ${q}</a>` +
        `<a class="result__snippet" href="https://example.com/${slug}">Snippet for ${q}</a></div></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  }) as typeof globalThis.fetch;
  const search = await createWebSearchExecute({ callTool: async () => { throw new Error('must not reach MCP'); }, close: async () => {} } as never, ENV, new WebSearchLedger())(
    'call-search-1',
    { query: 'shared store probe' },
    undefined,
  );
  const searchDetails = (search.details as { details: Record<string, unknown> }).details;
  const responseId = searchDetails.responseId;
  assert.equal(typeof responseId, 'string');

  throwFetch();
  const out = await createFetchExecute(ENV)('call-xstore-1', { responseId }, undefined);
  const command = commandOf(out);
  assert.equal(command.outcome, 'success');
  const text = (out.content as Array<{ text: string }>)[0]!.text;
  assert.ok(text.includes('shared store probe'));
  assert.ok(getNativeFetchStore().get(responseId as string) !== undefined, 'same parent store identity');
});

test('route + handler bounds aligned: topK/sourceIds/contradictory action reject before dispatch', async () => {
  // Route-level.
  assert.throws(() => buildFetchRoute({ url: 'https://example.com/', topK: 21 }), /topK must be an integer 1\.\.20/);
  assert.throws(() => buildFetchRoute({ url: 'https://example.com/', topK: '5' as never }), /topK must be an integer/);
  assert.throws(() => buildFetchRoute({ responseId: 'r', sourceIds: new Array(33).fill('s') }), /at most 32/);
  assert.throws(() => buildFetchRoute({ responseId: 'r', sourceIds: ['ok', 7] as never }), /non-empty strings/);
  assert.throws(() => buildFetchRoute({ responseId: 'r', sourceIds: ['ok', ''] as never }), /non-empty strings/);
  assert.throws(() => buildFetchRoute({ responseId: 'r', claims: ['c'], sourceIds: [''] as never }), /non-empty strings/);
  assert.throws(() => buildFetchRoute({ url: 'https://example.com/', action: 'retrieve' } as never), /no longer accepts 'action'/);
  // Handler-level internal action compatibility.
  assert.throws(() => parseFetchReadArgs({ url: 'https://example.com/', topK: 21 }), /topK must be an integer 1\.\.20/);
  assert.throws(() => parseFetchReadArgs({ responseId: 'r', sourceIds: new Array(33).fill('s') }), /at most 32/);
  assert.throws(() => parseFetchReadArgs({ responseId: 'r', sourceIds: ['ok', 7] }), /non-empty strings/);
  assert.throws(() => parseFetchReadArgs({ url: 'https://example.com/', action: 'retrieve' }), /rejects action/);
  assert.throws(() => parseFetchReadArgs({ responseId: 'r', action: 'read' }), /rejects action/);
  assert.throws(() => parseFetchReadArgs({ responseId: 'r', claims: ['c'], action: 'retrieve' }), /rejects action/);
  assert.throws(() => parseFetchReadArgs({ urls: ['https://example.com/a'], action: 'read' }), /rejects action/);

  // No dispatch on rejection: fetchPageText spy stays untouched.
  let calls = 0;
  throwFetch();
  const execute = createFetchExecute(ENV, {
    lookup: PUBLIC_DNS,
    fetchPageText: async () => { calls += 1; return 'x'; },
  });
  await assert.rejects(() => execute('call-rej-1', { url: 'https://example.com/', topK: 21 }, undefined), /topK/);
  await assert.rejects(() => execute('call-rej-2', { responseId: 'r', sourceIds: new Array(33).fill('s') }, undefined), /32/);
  assert.equal(calls, 0, 'rejection happens before dispatch');
});

test('failure/auth/SSRF retryability + output status mapping do not regress', async () => {
  // SSRF terminal, not retryable.
  await assert.rejects(
    () => createFetchExecute(ENV, { lookup: LOOPBACK_DNS })('call-ssrf-1', { url: 'http://127.0.0.1:8080/private' }, undefined),
    (error: unknown) => {
      const cmd = (error as { commandResult?: { outcome: string; retryability: string; error?: { code: string; retryable: boolean } } }).commandResult;
      assert.ok(cmd);
      assert.equal(cmd.outcome, 'failed');
      assert.equal(cmd.error?.code, 'ssrf_denied');
      assert.equal(cmd.retryability, 'not_retryable');
      assert.equal(cmd.error?.retryable, false);
      return true;
    },
  );
  // Invalid input rejects before dispatch (route-level plain error, no invented command result).
  await assert.rejects(
    () => createFetchExecute(ENV)('call-bad-1', { url: 'ftp://example.com/x' }, undefined),
    /HTTP\(S\) or GitHub asset URL/,
  );
  // Unknown responseId fails (never empty success).
  throwFetch();
  await assert.rejects(
    () => createFetchExecute(ENV)('call-miss-1', { responseId: 'non-existent-resp-id' }, undefined),
    (error: unknown) => {
      const cmd = (error as { commandResult?: { outcome: string } }).commandResult;
      assert.ok(cmd);
      assert.equal(cmd.outcome, 'failed');
      return true;
    },
  );
  // Cancelled stays cancelled.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createFetchExecute(ENV)('call-cancel-1', { url: 'https://example.com/' }, controller.signal),
    (error: unknown) => {
      const cmd = (error as { commandResult?: { outcome: string; error?: { code: string } } }).commandResult;
      assert.ok(cmd);
      assert.equal(cmd.outcome, 'cancelled');
      assert.equal(cmd.error?.code, 'cancelled');
      return true;
    },
  );
});
