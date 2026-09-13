import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiffbotError, type DiffbotFetchOptions } from '../../src/diffbot/diffbot-transport.js';
import { GRAPH_ADAPTER_V, GRAPH_PROVIDER } from '../../src/diffbot/diffbot-graph.js';
import { diffbotGraphAdapter } from '../../src/diffbot/diffbot-graph-adapter.js';

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

test('adapter identity matches native Diffbot language, provider, and cursor version', () => {
  assert.equal(diffbotGraphAdapter.language, 'dql');
  assert.equal(diffbotGraphAdapter.provider, GRAPH_PROVIDER);
  assert.equal(diffbotGraphAdapter.adapterCursorV, GRAPH_ADAPTER_V);
});

test('executeQuery passes native DQL through with identical paging and no token in body', async () => {
  const payload = { hits: 30, facet: false, data: [row()] };
  const { calls, fetchFn } = mockFetch(() => payload);
  const out = await diffbotGraphAdapter.executeQuery(
    { query: 'type:Organization', pageSize: 10, from: 10 },
    // Adapter fetch shape is provider-neutral; the Diffbot wrapper forwards it
    // to the native transport unchanged.
    { token: TOKEN, fetchFn: fetchFn as never },
  );
  assert.equal(out.error, undefined);
  assert.equal(out.provider, GRAPH_PROVIDER);
  assert.equal(out.shape, 'rows');
  assert.deepEqual(out.result, payload);
  assert.deepEqual(out.pagination, { hasMore: true, nextFrom: 20 });
  assert.equal(calls.length, 1);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.type, 'query');
  assert.equal(body.query, 'type:Organization');
  assert.equal(body.size, 10);
  assert.equal(body.from, 10);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('executeQuery surfaces terminal page and error taxonomy unchanged', async () => {
  const { fetchFn: last } = mockFetch(() => ({ hits: 10, facet: false, data: [row()] }));
  const terminal = await diffbotGraphAdapter.executeQuery(
    { query: 'type:Organization', pageSize: 10, from: 0 },
    { token: TOKEN, fetchFn: last as never },
  );
  assert.deepEqual(terminal.pagination, { hasMore: false });

  const { fetchFn: denied } = mockFetch(() => {
    throw new DiffbotError('transport_invalid_response', `Diffbot API error (HTTP 401) boom ${TOKEN}`, { status: 401 });
  });
  const auth = await diffbotGraphAdapter.executeQuery(
    { query: 'type:Organization', pageSize: 10, from: 0 },
    { token: TOKEN, fetchFn: denied as never },
  );
  assert.equal(auth.error?.code, 'auth_required');
  assert.equal(auth.provider, GRAPH_PROVIDER);
  assert.ok(!String(auth.error?.message).includes(TOKEN));
});

test('probeCardinality keeps order with size-zero bodies and per-query errors', async () => {
  const { calls, fetchFn } = mockFetch((options) => {
    const body = options.body as Record<string, unknown>;
    if (body.query === 'bad') throw new DiffbotError('transport_invalid_response', 'Diffbot API error (HTTP 500)', { status: 500 });
    return { hits: 7 };
  });
  const out = await diffbotGraphAdapter.probeCardinality(
    { queries: ['type:Organization', 'bad'] },
    { token: TOKEN, fetchFn: fetchFn as never },
  );
  assert.equal(out.provider, GRAPH_PROVIDER);
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items[0], { query: 'type:Organization', status: 'ok', hits: 7 });
  assert.equal(out.items[1]!.status, 'error');
  for (const call of calls) {
    assert.equal((call.body as Record<string, unknown>).size, 0);
    assert.equal((call.body as Record<string, unknown>).from, 0);
  }
});

test('fetchSchemaSnapshot returns raw ontology snapshot unchanged', async () => {
  const ontology = { metadata: {}, types: { Organization: { name: 'Organization', fields: {} } } };
  const { calls, fetchFn } = mockFetch(() => ontology);
  const out = await diffbotGraphAdapter.fetchSchemaSnapshot({ token: TOKEN, fetchFn: fetchFn as never });
  assert.equal(out.error, undefined);
  assert.equal(out.provider, GRAPH_PROVIDER);
  assert.deepEqual(out.snapshot, ontology);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'GET');
});

test('missing token reports auth_required with zero transport calls', async () => {
  const { calls, fetchFn } = mockFetch(() => ({ hits: 1, data: [] }));
  const query = await diffbotGraphAdapter.executeQuery(
    { query: 'type:Organization', pageSize: 10, from: 0 },
    { token: '', fetchFn: fetchFn as never },
  );
  assert.equal(query.error?.code, 'auth_required');
  const probe = await diffbotGraphAdapter.probeCardinality(
    { queries: ['type:Organization'] },
    { token: '', fetchFn: fetchFn as never },
  );
  assert.equal(probe.items[0]!.status, 'error');
  const schema = await diffbotGraphAdapter.fetchSchemaSnapshot({ token: '', fetchFn: fetchFn as never });
  assert.equal(schema.error?.code, 'auth_required');
  assert.equal(calls.length, 0);
});
