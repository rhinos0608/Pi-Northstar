import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  classifySearchFailure,
  createWebSearchExecute,
  priorSearchResult,
  searchLedgerOptions,
  thrownCommandResult,
} from '../../src/index.js';
import { WebSearchLedger } from '../../src/web/web-search-ledger.js';
import type { SearchBackend } from '../../src/backend.js';

// Canonical provider path: route.tool search/research executes the command
// handler over native provider fetch, never the MCP child. The stub records
// MCP calls (must stay zero); deterministic provider HTML is served by mocking
// the global fetch seam (DuckDuckGo via PI_SEARCH_WEB_BACKENDS).
const ENV: Record<string, string | undefined> = { PI_SEARCH_WEB_BACKENDS: 'duckduckgo' };


function validFailedCommandResult(): Record<string, unknown> {
  return {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: 'search.web',
    invocationId: 'test-invocation-failed',
    outcome: 'failed',
    retryability: 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: 'web' }],
    trust: 'external',
    requestedSurface: 'pi',
    resolvedSurface: 'search.web',
    attemptedSurfaces: ['pi', 'search.web'],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: { code: 'authentication_required', message: 'auth denied', retryable: false, category: 'auth' },
  };
}

function validCancelledCommandResult(): Record<string, unknown> {
  return {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: 'search.web',
    invocationId: 'test-invocation-cancelled',
    outcome: 'cancelled',
    retryability: 'unknown',
    data: null,
    sources: [{ kind: 'external', name: 'web' }],
    trust: 'external',
    requestedSurface: 'pi',
    resolvedSurface: 'search.web',
    attemptedSurfaces: ['pi', 'search.web'],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: { code: 'cancelled', message: 'aborted', retryable: false, category: 'cancelled' },
  };
}

function stubClient(): SearchBackend {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client = {
    calls,
    async callTool(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      return { ok: true, marker: 'mcp-child-must-stay-unused' };
    },
    async close() {},
  };
  return client as unknown as SearchBackend;
}

function mcpCalls(client: SearchBackend): number {
  return (client as unknown as { calls: unknown[] }).calls.length;
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

function mockFetchSuccess(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    const url = String(input);
    if (url.includes('openalex.org')) {
      return new Response(JSON.stringify(OPENALEX_WORKS), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const parsed = new URL(url);
    const query = parsed.searchParams.get('q') ?? 'unknown';
    return new Response(htmlFor(query), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  fetchCalls = 0;
  savedFetch = globalThis.fetch;
  mockFetchSuccess();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

test('searchLedgerOptions carries safe filters only, never cursor or bodies', () => {
  const options = searchLedgerOptions({
    query: 'secret query text stays out of options',
    limit: 8,
    includeContent: true,
    recency: 'week',
    domains: ['example.com', '-blocked.com'],
    yearFrom: 2020,
    category: 'news',
    knowledge: { entities: true, facts: false },
    cursor: 'opaque-continuation-token',
  });
  assert.deepEqual(options, {
    limit: 8,
    includeContent: true,
    recency: 'week',
    domains: ['example.com', '-blocked.com'],
    yearFrom: 2020,
    category: 'news',
    knowledge: { entities: true },
  });
});

test('classifySearchFailure maps timeout/oversize/invalid/upstream conservatively', () => {
  assert.deepEqual(classifySearchFailure(new Error('request timed out after 30000ms')), { retryable: true, code: 'timeout' });
  assert.deepEqual(classifySearchFailure(new Error('response too large: 2MB exceeds limit')), { retryable: false, code: 'response_too_large' });
  assert.deepEqual(classifySearchFailure(new Error('invalid response contract')), { retryable: false, code: 'invalid_response' });
  assert.deepEqual(classifySearchFailure(new Error('socket hang up')), { retryable: true, code: 'upstream_error' });
});

test('priorSearchResult is static concise text without caller content', () => {
  for (const reason of ['suppressed', 'blocked'] as const) {
    const result = priorSearchResult(reason);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    assert.ok(text.length < 300, 'suppression pointer stays concise');
    assert.ok(!text.includes('s3cr3t'), 'no caller content in pointer');
    assert.equal((result.details as { ledger: string }).ledger, reason);
  }
});

test('concurrent duplicate shares the leader result with one provider fetch', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    await gate;
    const query = new URL(String(input)).searchParams.get('q') ?? 'unknown';
    return new Response(htmlFor(query), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof globalThis.fetch;
  const client = stubClient();
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const first = execute('call-1', { query: 'shared concurrent query' }, undefined);
  const second = execute('call-2', { query: 'shared concurrent query' }, undefined);
  release();
  const [leader, follower] = await Promise.all([first, second]);
  assert.deepEqual(follower, leader);
  assert.equal((follower.details as { ledger?: string }).ledger, undefined);
  assert.equal(fetchCalls, 1);
  assert.equal(mcpCalls(client), 0);
});

test('second identical search suppresses without a provider fetch', async () => {
  const client = stubClient();
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  const first = await execute('call-1', { query: 'pi agent ledger' }, undefined);
  assert.ok((first.details as { ledger?: string }).ledger === undefined, 'first run dispatches');
  const second = await execute('call-2', { query: 'pi agent ledger' }, undefined);
  assert.equal((second.details as { ledger: string }).ledger, 'suppressed');
  assert.equal(fetchCalls, 1);
  assert.equal(mcpCalls(client), 0);
});

test('suppressed repeat returns generated responseId + age with retrieve guidance', async () => {
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const first = await execute('call-1', { query: 'latest OpenAI news' }, undefined);
  const generated = (first.details as { details: { responseId?: unknown } }).details.responseId;
  assert.equal(typeof generated, 'string', 'single-query run generates a reusable responseId');
  const second = await execute('call-2', { query: 'latest OpenAI news' }, undefined);
  const details = second.details as { ledger?: string; responseId?: string; ageMs?: number; ageSec?: number };
  assert.equal(details.ledger, 'suppressed');
  assert.equal(details.responseId, generated, 'suppression surfaces the generated pointer, never a hardcoded id');
  assert.ok(typeof details.ageMs === 'number', 'suppressed details carry ageMs');
  const text = (second.content as Array<{ text: string }>)[0]!.text;
  assert.ok(text.includes(generated as string), 'suppressed text names the reusable pointer');
  assert.ok(text.includes('retrieve'), 'suppressed text guides freshness-policy reuse');
  assert.equal(fetchCalls, 1);
  assert.equal(mcpCalls(client), 0);
});

test('suppressed without a cached pointer falls back to static text', async () => {
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await execute('call-batch-1', { queries: ['pointerless alpha', 'pointerless beta'] }, undefined);
  const second = await execute('call-batch-2', { queries: ['pointerless alpha', 'pointerless beta'] }, undefined);
  const details = second.details as { ledger?: string; responseId?: string };
  assert.equal(details.ledger, 'suppressed');
  assert.equal(details.responseId, undefined);
  const text = (second.content as Array<{ text: string }>)[0]!.text;
  assert.ok(text.includes('Refine the query'), 'fallback text preserved when no pointer');
  assert.equal(mcpCalls(client), 0);
});

test('non-retryable provider failure blocks the repeat without another fetch', async () => {
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('invalid_response: backend returned malformed JSON');
  }) as typeof globalThis.fetch;
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await assert.rejects(execute('call-1', { query: 'poisoned ledger query' }, undefined));
  const blocked = await execute('call-2', { query: 'poisoned ledger query' }, undefined);
  assert.equal((blocked.details as { ledger: string }).ledger, 'blocked');
  assert.equal(fetchCalls, 1);
  assert.equal(mcpCalls(client), 0);
});

test('retryable provider failure allows one retry then blocks', async () => {
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('socket hang up');
  }) as typeof globalThis.fetch;
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await assert.rejects(execute('call-1', { query: 'flaky ledger query' }, undefined));
  const retry = createWebSearchExecute(client, ENV, ledger);
  await assert.rejects(retry('call-2', { query: 'flaky ledger query' }, undefined));
  const blocked = await createWebSearchExecute(client, ENV, ledger)('call-3', { query: 'flaky ledger query' }, undefined);
  assert.equal((blocked.details as { ledger: string }).ledger, 'blocked');
  assert.equal(fetchCalls, 2);
  assert.equal(mcpCalls(client), 0);
});

test('validation errors cancel without recording a failure block', async () => {
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await assert.rejects(
    execute('call-1', { query: 'x', limit: 21 }, undefined),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
    'web limit overflow must reject with invalid_request',
  );
  const again = await execute('call-2', { query: 'x', limit: 8 }, undefined);
  assert.ok((again.details as { ledger?: string }).ledger === undefined, 'no failure recorded for validation errors');
  assert.equal(mcpCalls(client), 0);
});

test('cursor continuations bypass the ledger and always dispatch', async () => {
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  await execute('call-1', { query: 'research topic', category: 'research', source: 'openalex', limit: 5 }, undefined);
  const continued = await execute(
    'call-2',
    { query: 'research topic', category: 'research', source: 'openalex', limit: 5, cursor: 'opaque-token' },
    undefined,
  );
  assert.ok((continued.details as { ledger?: string }).ledger === undefined, 'cursor reads must not suppress');
  const command = (continued.details as { details: { northstarCommand: { commandId: string } } }).details.northstarCommand;
  assert.equal(command.commandId, 'research.search', 'cursor continuation reaches the canonical handler, not the ledger');
  assert.equal(mcpCalls(client), 0);
});

test('ledger debug snapshot never stores query text, bodies, or secrets', async () => {
  const secret = 's3cr3t-token-body-value';
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const result = await execute('call-1', { query: `query carrying ${secret}` }, undefined);
  assert.ok(JSON.stringify(result).includes(secret), 'result body still reaches the caller');
  const snapshot = JSON.stringify(ledger.debugEntries());
  assert.ok(!snapshot.includes(secret), 'raw query text must not be stored');
  assert.ok(!snapshot.includes('s3cr3t'), 'secret fragments must not be stored');
  assert.equal(mcpCalls(client), 0);
});

test('failed leader retry: late follower coalesces on retry, not false suppressed', async () => {
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('socket hang up');
    await retryGate;
    const query = new URL(String(input)).searchParams.get('q') ?? 'unknown';
    return new Response(htmlFor(query), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof globalThis.fetch;
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const args = { query: 'three-caller race query' };
  const leader = execute('call-A', args, undefined);
  const followerB = execute('call-B', args, undefined);
  const followerC = execute('call-C', args, undefined);
  // Let the retry leader start its second provider fetch, then hold it
  // in-flight so the late follower re-begins onto the retry (coalesced)
  // instead of racing past. Then release: both followers share retry result.
  // Attach settlement handlers synchronously: the initial leader rejects fast
  // and the runner flags rejections left unobserved across the gate delay.
  const allSettled = Promise.allSettled([leader, followerB, followerC]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseRetry();
  const settled = await allSettled;
  assert.equal(settled[0]!.status, 'rejected', 'initial leader failure rejects');
  assert.equal(settled[1]!.status, 'fulfilled', 'first woken follower runs the retry');
  assert.equal(settled[2]!.status, 'fulfilled', 'late follower must not falsely suppress');
  if (settled[1]!.status !== 'fulfilled' || settled[2]!.status !== 'fulfilled') throw new Error('expected followers fulfilled');
  assert.deepEqual(settled[2]!.value, settled[1]!.value, 'late follower shares retry result');
  assert.notEqual((settled[2]!.value.details as { ledger?: string }).ledger, 'suppressed');
  assert.equal(fetchCalls, 2, 'one initial run plus one retry run');
  assert.equal(mcpCalls(client), 0);
});

test('web reject-on-overflow preserved through ledged dispatch', async () => {
  const client = stubClient();
  const execute = createWebSearchExecute(client, ENV, new WebSearchLedger());
  await assert.rejects(
    execute('call-1', { query: 'overflow', limit: 21 }, undefined),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
  await assert.rejects(
    execute('call-2', { query: 'overflow', category: 'research', limit: 31 }, undefined),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
  assert.equal(fetchCalls, 0);
  assert.equal(mcpCalls(client), 0);
});

test('sole Brave 401 via Pi ledger: first failed outcome records failure, repeat is blocked', async () => {
  let braveCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://api.search.brave.com/')) {
      braveCalls += 1;
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url} (no generic fallback)`);
  }) as typeof globalThis.fetch;
  const braveEnv: Record<string, string | undefined> = { BRAVE_API_KEY: 'fake-test-key', PI_SEARCH_WEB_BACKENDS: 'brave' };
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, braveEnv, ledger);
  const first = await execute('call-brave-1', { query: 'sole brave ledger failure' }, undefined);
  const firstCommand = ((first.details as { details: { northstarCommand: { outcome: string } } }).details as { northstarCommand: { outcome: string } }).northstarCommand;
  const direct = (first.details as { northstarCommand?: { outcome: string } }).northstarCommand;
  const outcome = firstCommand?.outcome ?? direct?.outcome;
  // callPiSearchHandler wraps BackendCallResult as details, so the command outcome
  // rides details.details.northstarCommand; accept either nesting.
  const resolved = (first.details as Record<string, unknown>);
  const nested = (resolved.details as Record<string, unknown> | undefined)?.northstarCommand as { outcome: string } | undefined;
  assert.equal(nested?.outcome ?? outcome, 'failed', 'first Brave 401 must surface a failed command outcome');
  assert.equal(mcpCalls(client), 0, 'canonical provider seam never touches the MCP child');
  const second = await execute('call-brave-2', { query: 'sole brave ledger failure' }, undefined);
  const secondDetails = second.details as { ledger?: string; responseId?: unknown };
  assert.equal(secondDetails.ledger, 'blocked', 'non-retryable failure repeat must block, never suppress');
  assert.equal(secondDetails.responseId, undefined, 'blocked failure carries no responseId');
  const text = (second.content as Array<{ text: string }>)[0]!.text;
  assert.ok(!text.includes('retrieve'), 'blocked failure offers no retrieval guidance');
  assert.ok(!text.includes('responseId'), 'blocked failure names no pointer');
  assert.equal(braveCalls, 1, 'blocked repeat must not dispatch another provider fetch');
  assert.equal(mcpCalls(client), 0);
});

test('thrown auth/403 via canonical seam: nonretryable, repeat blocked after one acquisition', async () => {
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('DuckDuckGo search failed with HTTP 403');
  }) as typeof globalThis.fetch;
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const firstError = await execute('call-auth-1', { query: 'thrown auth ledger query' }, undefined).then(
    () => { throw new Error('expected first auth run to reject'); },
    (error: unknown) => error,
  );
  const command = (firstError as { commandResult?: { outcome: string; error?: { code: string; retryable: boolean } } }).commandResult;
  assert.ok(command, 'thrown auth failure must carry the canonical commandResult');
  assert.equal(command.outcome, 'failed');
  assert.equal(command.error?.code, 'authentication_required');
  assert.equal(command.error?.retryable, false, 'authoritative auth bit stays nonretryable, never the message heuristic');
  const blocked = await execute('call-auth-2', { query: 'thrown auth ledger query' }, undefined);
  const details = blocked.details as { ledger?: string; responseId?: unknown };
  assert.equal(details.ledger, 'blocked', 'nonretryable thrown failure blocks the identical repeat');
  assert.equal(details.responseId, undefined, 'blocked failure carries no responseId');
  const text = (blocked.content as Array<{ text: string }>)[0]!.text;
  assert.ok(!text.includes('retrieve'), 'blocked failure offers no retrieval guidance');
  assert.equal(fetchCalls, 1, 'blocked repeat must not dispatch another provider fetch');
  assert.equal(mcpCalls(client), 0);
});

test('malformed commandResult ignored: retryable transport message retries via canonical seam', async () => {
  const malformed = { outcome: 'failed', error: { code: 'boom', message: 'nope', retryable: false } };
  assert.equal(thrownCommandResult(Object.assign(new Error('socket hang up'), { commandResult: malformed })), undefined);
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw Object.assign(new Error('socket hang up'), { commandResult: malformed });
  }) as typeof globalThis.fetch;
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const query = 'malformed result retry query alpha';
  await assert.rejects(execute('call-1', { query }, undefined));
  await assert.rejects(execute('call-2', { query }, undefined), 'malformed nonretryable bit must not block the heuristic retry');
  assert.equal(fetchCalls, 2);
  const blocked = await execute('call-3', { query }, undefined);
  assert.equal((blocked.details as { ledger: string }).ledger, 'blocked');
  assert.equal(fetchCalls, 2);
  assert.equal(mcpCalls(client), 0);
});

test('valid failed nonretryable survives AbortError name; caller abort still cancels', async () => {
  const failed = validFailedCommandResult();
  const parsed = thrownCommandResult(Object.assign(new Error('socket hang up'), { name: 'AbortError', commandResult: failed }));
  assert.equal(parsed?.outcome, 'failed', 'valid failed outcome stays authoritative despite AbortError name');
  assert.equal(parsed?.error?.retryable, false);
  const ledger = new WebSearchLedger();
  const begun = ledger.begin(['abort-name authoritative failure query'], {});
  assert.equal(begun.status, 'run');
  if (begun.status !== 'run') throw new Error('expected run');
  ledger.completeFailure(begun.key, { retryable: parsed!.error!.retryable, code: 'upstream_error' });
  assert.equal(ledger.begin(['abort-name authoritative failure query'], {}).status, 'blocked', 'valid failed must block, never cancel/retry');
  mockFetchSuccess();
  const client = stubClient();
  const ledger2 = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger2);
  const query = 'caller abort outranks valid failed query';
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute('call-abort-1', { query }, controller.signal));
  const retry = await execute('call-abort-2', { query }, undefined);
  assert.ok((retry.details as { ledger?: string }).ledger === undefined, 'caller-abort cancel must not block the repeat');
  assert.equal(mcpCalls(client), 0);
});

test('valid cancelled outcome cancels without a failure block', async () => {
  const cancelled = validCancelledCommandResult();
  assert.equal(thrownCommandResult(Object.assign(new Error('aborted'), { name: 'AbortError', commandResult: cancelled }))?.outcome, 'cancelled');
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw Object.assign(new Error('provider aborted mid-flight'), { name: 'AbortError' });
  }) as typeof globalThis.fetch;
  const client = stubClient();
  const ledger = new WebSearchLedger();
  const execute = createWebSearchExecute(client, ENV, ledger);
  const query = 'provider abort cancel query gamma';
  await assert.rejects(execute('call-1', { query }, undefined));
  await assert.rejects(execute('call-2', { query }, undefined), 'cancel must not record a failure block');
  assert.equal(fetchCalls, 2);
  assert.equal(mcpCalls(client), 0);
});
