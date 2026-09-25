import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { buildSearchRoute } from '../../src/web/web-search-route.js';
import { createWebSearchExecute } from '../../src/index.js';
import { WebSearchLedger } from '../../src/web/web-search-ledger.js';
import type { SearchBackend } from '../../src/backend.js';

const ENV: Record<string, string | undefined> = { PI_SEARCH_WEB_BACKENDS: 'duckduckgo' };

function stubClient(handler: (tool: string, args: Record<string, unknown>) => unknown): SearchBackend {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client = {
    calls,
    async callTool(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      return handler(tool, args);
    },
    async close() {},
  };
  return client as unknown as SearchBackend;
}

function htmlFor(query: string): string {
  const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    `<html><body><div><a class="result__a" href="https://example.com/${slug}">Title for ${query}</a>` +
    `<a class="result__snippet" href="https://example.com/${slug}">Snippet for ${query}</a></div></body></html>`
  );
}

const OPENALEX_WORKS = {
  results: [
    {
      id: 'https://openalex.org/W1',
      display_name: 'Attention Is All You Need',
      doi: 'https://doi.org/10.1/atten',
      publication_year: 2017,
      cited_by_count: 42,
      authorships: [],
    },
  ],
  meta: {},
};

let fetchCalls = 0;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  fetchCalls = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    const url = new URL(String(input));
    const query = url.searchParams.get('q') ?? 'unknown';
    return new Response(htmlFor(query), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

function northstarCommandOf(result: unknown): Record<string, unknown> {
  const details = (result as { details?: { details?: Record<string, unknown> } }).details;
  const command = details?.details?.northstarCommand;
  assert.ok(command && typeof command === 'object', 'plain search must carry handler northstarCommand metadata');
  return command as Record<string, unknown>;
}

test('pi single plain search executes the canonical handler with invocation identity', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const result = await execute('call-parity-1', { query: 'parity probe' }, undefined);
  const command = northstarCommandOf(result);
  assert.equal(command.commandId, 'search.web');
  assert.equal(command.invocationId, 'call-parity-1');
  assert.equal(command.outcome, 'success');
  assert.ok(fetchCalls >= 1, 'handler path dispatches provider fetch');
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0, 'plain search must not reach the MCP child');
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.ok(text.includes('Title for parity probe'), 'handler result text reaches the caller');
});

test('canonical plain/batch route args forward no resultFormat', () => {
  const single = buildSearchRoute({ query: 'parity probe' });
  assert.equal(single.tool, 'web_search');
  assert.equal('resultFormat' in single.args, false, 'single route must not forward route-only resultFormat');
  const batch = buildSearchRoute({ queries: ['alpha query', 'beta query'] });
  assert.equal(batch.tool, 'web_search');
  assert.equal('resultFormat' in batch.args, false, 'batch route must not forward route-only resultFormat');
  assert.deepEqual(batch.args.queries, ['alpha query', 'beta query']);
});

test('pi batch plain search fuses in deterministic input order', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const first = await createWebSearchExecute(client, ENV, new WebSearchLedger())(
    'call-batch-1',
    { queries: ['alpha query', 'beta query'] },
    undefined,
  );
  northstarCommandOf(first);
  const results = (first.details as { details: { results: Array<{ url: string }> } }).details.results;
  assert.equal(results.length, 2);
  assert.ok(results[0]!.url.includes('alpha-query'), 'first input query fuses first');
  assert.ok(results[1]!.url.includes('beta-query'), 'second input query fuses second');
  const fusion = (first.details as { details: { fusion: { method: string } } }).details.fusion;
  assert.equal(fusion.method, 'rrf');
  // Determinism across independent runs with a fresh ledger.
  const rerun = await createWebSearchExecute(client, ENV, new WebSearchLedger())(
    'call-batch-2',
    { queries: ['alpha query', 'beta query'] },
    undefined,
  );
  const rerunResults = (rerun.details as { details: { results: Array<{ url: string }> } }).details.results;
  assert.deepEqual(
    rerunResults.map((hit) => hit.url),
    results.map((hit) => hit.url),
    'batch fusion order is stable across runs',
  );
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0, 'batch must not reach the MCP child');
});

test('pi web_search rejects the removed agent mode before dispatch', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  await assert.rejects(
    () => execute('call-agent-1', { query: 'agent probe', mode: 'agent' }, undefined),
    /no longer supports agent mode or depth/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0);
});

test('pi research routing executes canonical handler without MCP dispatch', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'research-child' }));
  const result = await createWebSearchExecute(client, ENV, new WebSearchLedger())(
    'call-research-1', { query: 'survey', category: 'research' }, undefined,
  );
  const calls = (client as unknown as { calls: Array<{ tool: string }> }).calls;
  assert.equal(calls.length, 0, 'research handler must not reach MCP child');
  const details = result.details as { details: { northstarCommand: Record<string, unknown> } };
  assert.equal(details.details.northstarCommand.commandId, 'research.search');
  assert.equal(details.details.northstarCommand.invocationId, 'call-research-1');
});

test('pi batch plain search exposes no reusable responseId (false-provenance gate)', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const result = await execute('call-batch-noid-1', { queries: ['alpha query', 'beta query'] }, undefined);
  const handlerResult = (result.details as { details: Record<string, unknown> }).details;
  assert.equal(handlerResult.responseId, undefined, 'fused batch must not expose a reusable responseId');
  const command = handlerResult.northstarCommand as { outcome: string; data: Record<string, unknown> };
  assert.ok(command && typeof command === 'object');
  assert.equal(command.outcome, 'success', 'batch hits still succeed; only the cache pointer is gated');
  assert.equal((command.data as { responseId?: unknown }).responseId, undefined);
  const results = handlerResult.results as Array<{ url: string }>;
  assert.equal(results.length, 2, 'batch fusion results unchanged');
});

test('pi repeated batch suppression fabricates no responseId or retrieval guidance', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await execute('call-batch-sup-1', { queries: ['alpha query', 'beta query'] }, undefined);
  const repeated = await execute('call-batch-sup-2', { queries: ['alpha query', 'beta query'] }, undefined);
  const details = repeated.details as { action: string; ledger?: string; responseId?: unknown };
  assert.equal(details.ledger, 'suppressed', 'repeat batch still suppresses');
  assert.equal(details.responseId, undefined, 'suppressed batch must not fabricate a responseId');
  const text = (repeated.content as Array<{ text: string }>)[0]!.text;
  assert.ok(!text.includes('responseId'), 'suppressed batch must not offer retrieval guidance');
  assert.ok(!text.includes('retrieve'), 'suppressed batch must not offer retrieval guidance');
});

test('pi single plain search caches a reusable responseId', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const result = await execute('call-single-noid-1', { query: 'parity probe' }, undefined);
  const handlerResult = (result.details as { details: Record<string, unknown> }).details;
  const responseId = handlerResult.responseId;
  assert.equal(typeof responseId, 'string', 'single-query search must cache a responseId');
  assert.ok((responseId as string).length > 0);
  const { getNativeFetchStore } = await import('../../src/native-fetch.js');
  const { retrieveWebAccessCorpus } = await import('../../src/web/access/web-access-retrieve.js');
  const out = retrieveWebAccessCorpus(getNativeFetchStore(), { responseId: responseId as string });
  assert.ok(out.text.includes('parity probe'), 'cached single-query pointer serves via retrieve');
  const sharedLedger = new WebSearchLedger();
  const runAgain = createWebSearchExecute(client, ENV, sharedLedger);
  await runAgain('call-single-reuse-1', { query: 'single reuse probe' }, undefined);
  const suppressed = await runAgain('call-single-reuse-2', { query: 'single reuse probe' }, undefined);
  const suppressedDetails = suppressed.details as { action: string; ledger?: string; responseId?: unknown };
  assert.equal(suppressedDetails.ledger, 'suppressed', 'repeat single-query still suppresses');
  assert.equal(typeof suppressedDetails.responseId, 'string', 'single-query suppression keeps surfacing the pointer');
  const suppressedText = (suppressed.content as Array<{ text: string }>)[0]!.text;
  assert.ok(suppressedText.includes('retrieve'), 'single-query suppression keeps retrieval guidance');
});

test('pi research failure is ledgered as failure, not successful suppression', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'research-child' }));
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const first = await execute('call-research-failure-1', {
    query: 'unsupported source probe', category: 'research', source: 'not-a-source',
  }, undefined);
  const firstCommand = (first.details as { details: { northstarCommand: { outcome: string } } }).details.northstarCommand;
  assert.equal(firstCommand.outcome, 'failed');
  const second = await execute('call-research-failure-2', {
    query: 'unsupported source probe', category: 'research', source: 'not-a-source',
  }, undefined);
  assert.equal((second.details as { ledger?: string }).ledger, 'blocked');
  assert.equal((second.details as { responseId?: unknown }).responseId, undefined);
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0);
});

test('pi research source pin executes pinned adapter with zero MCP', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const seen: string[] = [];
  const outer = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    const url = String(input);
    seen.push(url);
    if (url.includes('openalex.org')) {
      return new Response(JSON.stringify(OPENALEX_WORKS), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const query = new URL(url).searchParams.get('q') ?? 'unknown';
    return new Response(htmlFor(query), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof globalThis.fetch;
  try {
    const result = await createWebSearchExecute(client, ENV, new WebSearchLedger())(
      'call-pin-1', { query: 'transformers', category: 'research', source: 'openalex', limit: 3 }, undefined,
    );
    const command = (result.details as { details: { northstarCommand: { commandId: string; outcome: string } } }).details.northstarCommand;
    assert.equal(command.commandId, 'research.search');
    assert.equal(command.outcome, 'success');
    assert.ok(seen.some((url) => url.includes('openalex.org')), 'pinned adapter must dispatch');
    assert.ok(!seen.some((url) => url.includes('duckduckgo')), 'pinned source must not substitute generic web');
    assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0, 'pinned research must not reach the MCP child');
  } finally {
    globalThis.fetch = outer;
  }
});

test('pi research source all fans out canonical handler with zero MCP', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const before = fetchCalls;
  const result = await createWebSearchExecute(client, ENV, new WebSearchLedger())(
    'call-all-1', { query: 'survey', category: 'research', source: 'all' }, undefined,
  );
  const command = (result.details as { details: { northstarCommand: { commandId: string } } }).details.northstarCommand;
  assert.equal(command.commandId, 'research.search');
  assert.ok(fetchCalls > before, 'aggregate source must dispatch provider fetch');
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.ok(!text.includes('Title for '), 'aggregate research must not carry generic web fusion markers');
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0, 'aggregate research must not reach the MCP child');
});

test('pi research limit 30 accepted, 31 rejected pre-dispatch', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const ok = await execute('call-lim-1', { query: 'transformers', category: 'research', source: 'openalex', limit: 30 }, undefined);
  const okCommand = (ok.details as { details: { northstarCommand: { commandId: string } } }).details.northstarCommand;
  assert.equal(okCommand.commandId, 'research.search');
  const dispatched = fetchCalls;
  assert.ok(dispatched >= 1, 'limit 30 must dispatch provider fetch');
  await assert.rejects(
    execute('call-lim-2', { query: 'transformers', category: 'research', source: 'openalex', limit: 31 }, undefined),
    /1.*30/,
  );
  assert.equal(fetchCalls, dispatched, 'limit 31 must reject before any provider fetch');
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0);
});

test('pi research cursor continuation bypasses suppression and preserves exact source', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  let page = 0;
  const outer = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    page += 1;
    const url = String(input);
    assert.ok(url.includes('openalex.org'), 'continuation must stay on the pinned source');
    const body = page === 1
      ? { results: OPENALEX_WORKS.results, meta: { next_cursor: 'IopXcm1jdg==' } }
      : { results: OPENALEX_WORKS.results, meta: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    const ledger = new WebSearchLedger();
    const execute = createWebSearchExecute(client, ENV, ledger);
    const first = await execute('call-cur-1', { query: 'transformers', category: 'research', source: 'openalex', limit: 1 }, undefined);
    const firstInner = (first.details as { details: Record<string, unknown> }).details;
    const cursor = ((firstInner.northstar as { pagination?: { nextCursor?: unknown } } | undefined)?.pagination?.nextCursor);
    assert.equal(typeof cursor, 'string', 'first page must issue a continuation cursor');
    const before = fetchCalls;
    const second = await execute(
      'call-cur-2',
      { query: 'transformers', category: 'research', source: 'openalex', limit: 1, cursor: cursor as string },
      undefined,
    );
    assert.ok((second.details as { ledger?: string }).ledger === undefined, 'cursor continuation must bypass suppression');
    assert.ok(fetchCalls > before, 'cursor continuation must dispatch provider fetch again');
    const secondInner = (second.details as { details: { source: string; northstarCommand: { commandId: string } } }).details;
    assert.equal(secondInner.source, 'openalex', 'continuation must preserve the exact source');
    assert.equal(secondInner.northstarCommand.commandId, 'research.search');
    assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0);
  } finally {
    globalThis.fetch = outer;
  }
});

test('pi research failure and empty never fall back to generic web or MCP', async () => {
  const client = stubClient(() => ({ ok: true, marker: 'mcp-child' }));
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const failed = await execute('call-rf-1', { query: 'probe', category: 'research', source: 'not-a-source' }, undefined);
  const failedCommand = (failed.details as { details: { northstarCommand: { outcome: string } } }).details.northstarCommand;
  assert.equal(failedCommand.outcome, 'failed');
  const failedText = (failed.content as Array<{ text: string }>)[0]!.text;
  assert.ok(!failedText.includes('Title for '), 'research failure must not carry generic web markers');
  const outer = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    const url = String(input);
    if (url.includes('openalex.org')) {
      return new Response(JSON.stringify({ results: [], meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const query = new URL(url).searchParams.get('q') ?? 'unknown';
    return new Response(htmlFor(query), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof globalThis.fetch;
  try {
    const empty = await execute('call-re-1', { query: 'nothing matches this topic', category: 'research', source: 'openalex' }, undefined);
    const emptyCommand = (empty.details as { details: { northstarCommand: { outcome: string } } }).details.northstarCommand;
    assert.equal(emptyCommand.outcome, 'empty');
    const emptyText = (empty.content as Array<{ text: string }>)[0]!.text;
    assert.ok(emptyText.includes('No research results'), 'empty research stays research-shaped');
    assert.ok(!emptyText.includes('Title for '), 'empty research must not carry generic web markers');
  } finally {
    globalThis.fetch = outer;
  }
  assert.equal((client as unknown as { calls: unknown[] }).calls.length, 0, 'research failure/empty must not reach the MCP child');
});
