import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiffbotError, type DiffbotFetchOptions } from '../src/diffbot-transport.js';
import {
  GRAPH_ADAPTER_V,
  GRAPH_DQL_PATH,
  GRAPH_ONTOLOGY_PATH,
  fetchDiffbotOntology,
  probeDiffbotGraph,
  queryDiffbotGraph,
} from '../src/diffbot-graph.js';

const TOKEN = 'test-token-abc123';

function mockFetch(handler: (options: DiffbotFetchOptions) => unknown) {
  const calls: DiffbotFetchOptions[] = [];
  const fetchFn = async (options: DiffbotFetchOptions): Promise<unknown> => {
    calls.push(options);
    return handler(options);
  };
  return { calls, fetchFn };
}

function row(name = 'Acme') {
  return { score: 1, entity: { diffbotUri: 'https://diffbot.com/entity/1', type: 'Organization', name } };
}

// ── query transport shape ──

test('query POSTs DQL body without token in body', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ hits: 1, facet: false, data: [row()] }));
  const out = await queryDiffbotGraph({ query: 'type:Organization', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.equal(out.error, undefined);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(String(call.host), 'https://kg.diffbot.com');
  assert.equal(call.path, GRAPH_DQL_PATH);
  assert.equal(call.method, 'POST');
  const body = call.body as Record<string, unknown>;
  assert.equal(body.type, 'query');
  assert.equal(body.query, 'type:Organization');
  assert.equal(body.size, 10);
  assert.equal(body.from, 0);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.equal(call.token, TOKEN);
});

test('query maps from cursor state and emits continuation only for rows', async () => {
  const { fetchFn } = mockFetch(() => ({ hits: 30, facet: false, data: [row()] }));
  const out = await queryDiffbotGraph({ query: 'type:Organization', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.equal(out.shape, 'rows');
  assert.equal(out.pagination?.hasMore, true);
  assert.equal(out.pagination?.nextFrom, 10);
});

test('query emits no continuation for last rows page', async () => {
  const { fetchFn } = mockFetch(() => ({ hits: 10, facet: false, data: [row()] }));
  const out = await queryDiffbotGraph({ query: 'type:Organization', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.equal(out.shape, 'rows');
  assert.equal(out.pagination?.hasMore, false);
  assert.equal(out.pagination?.nextFrom, undefined);
});

test('query classifies facets by explicit facet marker and never paginates', async () => {
  const { fetchFn } = mockFetch(() => ({ facet: true, data: [{ key: 'x', count: 3 }] }));
  const out = await queryDiffbotGraph({ query: 'type:Organization', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.equal(out.shape, 'facets');
  assert.equal(out.pagination, undefined);
});

test('query classifies explicit aggregate markers and falls back to object', async () => {
  const { fetchFn: agg } = mockFetch(() => ({ report: { total: 5 } }));
  assert.equal((await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn: agg })).shape, 'aggregate');
  const { fetchFn: amb } = mockFetch(() => ({ something: 'else' }));
  assert.equal((await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn: amb })).shape, 'object');
});

test('query classifies JSON primitives as scalar', async () => {
  const { fetchFn } = mockFetch(() => 42);
  const out = await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.equal(out.shape, 'scalar');
  assert.deepEqual(out.result, 42);
});

test('query preserves provider result intact under result', async () => {
  const payload = { hits: 1, facet: false, data: [row('Beta')], extra: { a: 1 } };
  const { fetchFn } = mockFetch(() => payload);
  const out = await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.deepEqual(out.result, payload);
});

// ── query error taxonomy ──

test('query maps 401/403 to auth_required without token leakage', async () => {
  const { fetchFn } = mockFetch(() => {
    throw new DiffbotError('transport_invalid_response', `Diffbot API error (HTTP 401) boom ${TOKEN}`, { status: 401 });
  });
  const out = await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.equal(out.error?.code, 'auth_required');
  assert.ok(!String(out.error?.message).includes(TOKEN));
});

test('query maps 429 to rate_limited', async () => {
  const { fetchFn } = mockFetch(() => {
    throw new DiffbotError('transport_invalid_response', 'Diffbot API error (HTTP 429)', { status: 429 });
  });
  const out = await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn });
  assert.equal(out.error?.code, 'rate_limited');
  assert.equal(out.error?.retryable, true);
});

test('query maps caller abort to operation_aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchFn } = mockFetch(() => {
    throw new DiffbotError('transport_invalid_response', 'This operation was aborted', { retryable: true });
  });
  const out = await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn, signal: controller.signal });
  assert.equal(out.error?.code, 'operation_aborted');
});

test('query maps oversize to response_too_large and malformed to contract error', async () => {
  const { fetchFn: big } = mockFetch(() => {
    throw new DiffbotError('response_too_large', 'Diffbot response too large', {});
  });
  assert.equal((await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn: big })).error?.code, 'response_too_large');
  const { fetchFn: bad } = mockFetch(() => undefined);
  const out = await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: TOKEN, fetchFn: bad });
  assert.equal(out.error?.code, 'contract_invalid_response');
});

test('query without token returns auth_required with zero calls', async () => {
  const { calls, fetchFn } = mockFetch(() => ({}));
  const out = await queryDiffbotGraph({ query: 'q', pageSize: 10, from: 0 }, { token: '', fetchFn });
  assert.equal(out.error?.code, 'auth_required');
  assert.equal(calls.length, 0);
});

test('adapter exposes cursor version 1 and fixed paths', () => {
  assert.equal(GRAPH_ADAPTER_V, 1);
  assert.equal(GRAPH_DQL_PATH, '/kg/v3/dql');
  assert.equal(GRAPH_ONTOLOGY_PATH, '/kg/ontology');
});

test('ontology GETs the ontology path with token outside the body', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ types: { Person: { fields: {} } } }));
  const out = await fetchDiffbotOntology({ token: TOKEN, fetchFn });
  assert.equal(out.error, undefined);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(String(call.host), 'https://kg.diffbot.com');
  assert.equal(call.path, GRAPH_ONTOLOGY_PATH);
  assert.equal(call.method, 'GET');
  assert.equal(call.token, TOKEN);
  assert.equal(call.body, undefined);
});

test('ontology without typed type markers maps to contract_invalid_response', async () => {
  const { fetchFn } = mockFetch(() => ({}));
  const out = await fetchDiffbotOntology({ token: TOKEN, fetchFn });
  assert.equal(out.error?.code, 'contract_invalid_response');
  assert.equal(out.ontology, undefined);
});

test('ontology exceeding JSON bounds maps to response_too_large', async () => {
  let deep: unknown = 0;
  for (let depth = 0; depth < 40; depth++) deep = { layer: deep };
  const { fetchFn } = mockFetch(() => ({ types: { Person: deep } }));
  const out = await fetchDiffbotOntology({ token: TOKEN, fetchFn });
  assert.equal(out.error?.code, 'response_too_large');
  assert.equal(out.ontology, undefined);
});

test('ontology without token returns auth_required with zero calls', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ types: {} }));
  const out = await fetchDiffbotOntology({ token: '', fetchFn });
  assert.equal(out.error?.code, 'auth_required');
  assert.equal(calls.length, 0);
});

test('probe without token returns auth_required for every query with zero calls', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ hits: 1 }));
  const out = await probeDiffbotGraph({ queries: ['type:Person', 'type:Organization'] }, { token: '', fetchFn });
  assert.equal(out.items.length, 2);
  for (const item of out.items) {
    assert.equal(item.status, 'error');
    if (item.status === 'error') assert.equal(item.error.code, 'auth_required');
  }
  assert.equal(calls.length, 0);
});

// ── probe ──

test('probe rejects known non-countable syntax without HTTP', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ hits: 1 }));
  const out = await probeDiffbotGraph({ queries: ['type:Person facet:employer', 'type:Organization name:"A"'] }, { token: TOKEN, fetchFn });
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0]?.status, 'error');
  assert.equal(calls.length, 1);
});

test('probe keeps input order with per-query errors and size-zero bodies', async () => {
  const seen: unknown[] = [];
  const { fetchFn } = mockFetch((options) => {
    seen.push(options.body);
    const body = options.body as Record<string, unknown>;
    if (body.query === 'bad') return {};
    return { hits: 7 };
  });
  const out = await probeDiffbotGraph({ queries: ['type:A', 'bad', 'type:B'] }, { token: TOKEN, fetchFn });
  assert.equal(out.items.length, 3);
  assert.equal(out.items[0]?.status, 'ok');
  assert.equal(out.items[1]?.status, 'error');
  assert.equal(out.items[2]?.status, 'ok');
  if (out.items[0]?.status === 'ok') assert.equal(out.items[0].hits, 7);
  for (const body of seen) assert.equal((body as Record<string, unknown>).size, 0);
});

test('probe caps internal concurrency at 8', async () => {
  let inFlight = 0;
  let maxFlight = 0;
  const fetchFn = async (_options: DiffbotFetchOptions): Promise<unknown> => {
    inFlight += 1;
    maxFlight = Math.max(maxFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { hits: 1 };
  };
  const out = await probeDiffbotGraph({ queries: Array(20).fill('type:Organization name:"A"') }, { token: TOKEN, fetchFn });
  assert.equal(out.items.length, 20);
  assert.ok(maxFlight <= 8, `max in-flight ${maxFlight} exceeds 8`);
});

test('probe requires finite non-negative integer hits', async () => {
  const { fetchFn } = mockFetch(() => ({ hits: -1 }));
  const out = await probeDiffbotGraph({ queries: ['type:Organization'] }, { token: TOKEN, fetchFn });
  assert.equal(out.items[0]?.status, 'error');
});
