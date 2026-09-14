import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSparqlGraphAdapter, fetchSparqlSchemaView } from '../../src/sparql/sparql-graph.js';
import type { SparqlFetchFn } from '../../src/sparql/sparql-transport.js';

const ENDPOINT = 'https://sparql.example.org/sparql';
const SENTINEL = 'SENTINEL_SPARQL_TOKEN_xyz789';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/sparql-results+json' },
  });
}

test('adapter identity: language sparql, provider sparql', () => {
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn: (async () => jsonResponse({})) as SparqlFetchFn });
  assert.equal(adapter.language, 'sparql');
  assert.equal(adapter.provider, 'sparql');
  assert.equal(adapter.adapterCursorV, 1);
});

test('query rejects update forms and SERVICE federation before dispatch', async () => {
  let calls = 0;
  const fetchFn: SparqlFetchFn = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  for (const query of [
    'INSERT DATA { <http://ex.org/s> <http://ex.org/p> <http://ex.org/o> }',
    'DELETE WHERE { ?s ?p ?o }',
    'SELECT * WHERE { ?s ?p ?o . SERVICE <http://other.example.org/sparql> { ?s ?p ?o } }',
  ]) {
    const outcome = await adapter.executeQuery({ query, pageSize: 10, from: 0 }, { token: SENTINEL });
    assert.equal(outcome.provider, 'sparql');
    assert.ok(outcome.error, `expected error for: ${query}`);
    assert.equal(outcome.error.code, 'unsupported_option');
    assert.ok(!outcome.error.message.includes(SENTINEL), 'token leaked in gate error');
  }
  assert.equal(calls, 0);
});

test('probe wraps countable SELECT as COUNT(*), per-item errors for unsupported forms', async () => {
  const seenBodies: string[] = [];
  const fetchFn: SparqlFetchFn = (async (_url: string, init?: RequestInit) => {
    seenBodies.push(String(init?.body ?? ''));
    return jsonResponse({
      head: { vars: ['count'] },
      results: { bindings: [{ count: { type: 'literal', value: '42' } }] },
    });
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const outcome = await adapter.probeCardinality(
    {
      queries: [
        'SELECT * WHERE { ?s ?p ?o }',
        'ASK { ?s ?p ?o }',
        'INSERT DATA { <http://ex.org/s> <http://ex.org/p> <http://ex.org/o> }',
      ],
    },
    { token: SENTINEL },
  );
  assert.equal(outcome.provider, 'sparql');
  assert.equal(outcome.items.length, 3);
  const [select, ask, insert] = outcome.items;
  assert.equal(select?.status, 'ok');
  if (select?.status === 'ok') assert.equal(select.hits, 42);
  assert.equal(ask?.status, 'error');
  assert.equal(insert?.status, 'error');
  if (ask?.status === 'error') assert.equal(ask.error.code, 'unsupported_option');
  if (insert?.status === 'error') assert.equal(insert.error.code, 'unsupported_option');
  assert.equal(seenBodies.length, 1);
  assert.ok(decodeURIComponent(seenBodies[0] ?? '').match(/COUNT\(\*\)/i), 'probe must dispatch COUNT(*) wrapper');
});

test('probe redacts token in per-item transport errors', async () => {
  const fetchFn: SparqlFetchFn = (async () => jsonResponse({ error: 'boom' }, 503)) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const outcome = await adapter.probeCardinality({ queries: ['SELECT * WHERE { ?s ?p ?o }'] }, { token: SENTINEL });
  assert.equal(outcome.items.length, 1);
  const item = outcome.items[0];
  assert.equal(item?.status, 'error');
  if (item?.status === 'error') assert.ok(!item.error.message.includes(SENTINEL));
});

test('schema snapshot returns bounded types discovery payload', async () => {
  const payload = {
    head: { vars: ['type'] },
    results: { bindings: [{ type: { type: 'uri', value: 'http://ex.org/Person' } }] },
  };
  const fetchFn: SparqlFetchFn = (async () => jsonResponse(payload)) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const outcome = await adapter.fetchSchemaSnapshot({ token: SENTINEL });
  assert.equal(outcome.provider, 'sparql');
  assert.equal(outcome.error, undefined);
  assert.ok(outcome.snapshot !== undefined && typeof outcome.snapshot === 'object');
});

test('schema views map fixed discovery queries to portable shapes', async () => {
  const seenQueries: string[] = [];
  const fetchFn: SparqlFetchFn = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const query = decodeURIComponent(body.replace(/^query=/, ''));
    seenQueries.push(query);
    if (query.includes('?type') && query.includes('REGEX')) {
      return jsonResponse({
        head: { vars: ['type'] },
        results: { bindings: [{ type: { type: 'uri', value: 'http://ex.org/Person' } }] },
      });
    }
    if (query.includes('?p ?o')) {
      return jsonResponse({
        head: { vars: ['p', 'o'] },
        results: { bindings: [{ p: { type: 'uri', value: 'http://ex.org/name' }, o: { type: 'literal', value: 'Ada' } }] },
      });
    }
    return jsonResponse({
      head: { vars: ['p'] },
      results: { bindings: [{ p: { type: 'uri', value: 'http://ex.org/name' } }] },
    });
  }) as SparqlFetchFn;
  const options = { endpoint: ENDPOINT, fetchFn };
  const ctx = { token: SENTINEL };
  const fields = await fetchSparqlSchemaView({ action: 'schema', language: 'sparql', view: 'fields' }, options, ctx);
  assert.equal(fields.error, undefined);
  assert.deepEqual(fields.result, {
    view: 'fields',
    fields: [{ name: 'http://ex.org/name' }],
  });
  const search = await fetchSparqlSchemaView({ action: 'schema', language: 'sparql', view: 'search', query: 'Person' }, options, ctx);
  assert.equal(search.error, undefined);
  assert.deepEqual(search.result, {
    view: 'search',
    query: 'Person',
    matches: [{ name: 'http://ex.org/Person', kind: 'type' }],
  });
  const describe = await fetchSparqlSchemaView(
    { action: 'schema', language: 'sparql', view: 'describe', name: 'http://ex.org/Person' },
    options,
    ctx,
  );
  assert.equal(describe.error, undefined);
  assert.equal(describe.result?.view, 'describe');
  for (const query of seenQueries) {
    assert.ok(!/\bSERVICE\b/i.test(query), 'discovery query must not federate');
    assert.ok(/^\s*(?:PREFIX[\s\S]*?)?SELECT\b/i.test(query), 'discovery query must be SELECT');
  }
});

test('schema views reject bad selectors without dispatch', async () => {
  let calls = 0;
  const fetchFn: SparqlFetchFn = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as SparqlFetchFn;
  const options = { endpoint: ENDPOINT, fetchFn };
  const ctx = { token: SENTINEL };
  const search = await fetchSparqlSchemaView({ action: 'schema', language: 'sparql', view: 'search' }, options, ctx);
  assert.equal(search.error?.code, 'invalid_input');
  const describe = await fetchSparqlSchemaView({ action: 'schema', language: 'sparql', view: 'describe', name: '   ' }, options, ctx);
  assert.equal(describe.error?.code, 'invalid_input');
  assert.equal(calls, 0);
});

test('fields view rejects IRI injection without dispatch', async () => {
  let calls = 0;
  const fetchFn: SparqlFetchFn = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as SparqlFetchFn;
  const options = { endpoint: ENDPOINT, fetchFn };
  const ctx = { token: SENTINEL };
  for (const name of [
    'http://ex.org/Person> <http://ex.org/p> <http://ex.org/o> } #',
    'http://ex.org/Person> INSERT DATA { <http://ex.org/s> <http://ex.org/p> <http://ex.org/o> } #',
    'not-a-url',
    'ftp://ex.org/Person',
  ]) {
    for (const view of ['fields', 'describe'] as const) {
      const outcome = await fetchSparqlSchemaView({ action: 'schema', language: 'sparql', view, name }, options, ctx);
      assert.equal(outcome.error?.code, 'invalid_input', `expected invalid_input for ${view}: ${name}`);
    }
  }
  assert.equal(calls, 0);
});

test('search view escapes double-quote payload inside REGEX literal', async () => {
  const seenQueries: string[] = [];
  const fetchFn: SparqlFetchFn = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    seenQueries.push(decodeURIComponent(body.replace(/^query=/, '')));
    return jsonResponse({ head: { vars: ['type'] }, results: { bindings: [] } });
  }) as SparqlFetchFn;
  const payload = 'Person") } #';
  const outcome = await fetchSparqlSchemaView(
    { action: 'schema', language: 'sparql', view: 'search', query: payload },
    { endpoint: ENDPOINT, fetchFn },
    { token: SENTINEL },
  );
  assert.equal(outcome.error, undefined);
  assert.equal(seenQueries.length, 1);
  const dispatched = seenQueries[0] ?? '';
  assert.ok(dispatched.includes('\\"'), 'double quote must be backslash-escaped in REGEX literal');
  assert.ok(!dispatched.includes(`"${payload}"`), 'raw quote payload must not appear unescaped');
});

test('query rejects trailing-update stacking but allows trailing semicolon', async () => {
  let calls = 0;
  const payload = { head: { vars: ['s'] }, results: { bindings: [] } };
  const fetchFn: SparqlFetchFn = (async () => {
    calls += 1;
    return jsonResponse(payload);
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const stacked = await adapter.executeQuery(
    { query: 'SELECT * WHERE { ?s ?p ?o } ; INSERT DATA { <http://ex.org/s> <http://ex.org/p> <http://ex.org/o> }', pageSize: 10, from: 0 },
    { token: SENTINEL },
  );
  assert.equal(stacked.error?.code, 'unsupported_option');
  const plain = await adapter.executeQuery(
    { query: 'SELECT * WHERE { ?s ?p ?o }', pageSize: 10, from: 0 },
    { token: SENTINEL },
  );
  assert.equal(plain.error, undefined);
  const trailingSemi = await adapter.executeQuery(
    { query: 'SELECT * WHERE { ?s ?p ?o } ;   ', pageSize: 10, from: 0 },
    { token: SENTINEL },
  );
  assert.equal(trailingSemi.error, undefined);
  assert.equal(calls, 2);
});

test('query executes prefixed SELECT without misclassifying preamble', async () => {
  const payload = { head: { vars: ['s'] }, results: { bindings: [{ s: { type: 'uri', value: 'http://ex.org/a' } }] } };
  let calls = 0;
  const fetchFn: SparqlFetchFn = (async () => {
    calls += 1;
    return jsonResponse(payload);
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const outcome = await adapter.executeQuery(
    { query: 'PREFIX ex: <http://ex.org/> SELECT * WHERE { ?s ?p ?o }', pageSize: 10, from: 0 },
    { token: SENTINEL },
  );
  assert.equal(outcome.error, undefined);
  assert.equal(calls, 1);
});

test('query executes default-prefix SELECT without misclassifying preamble', async () => {
  const payload = { head: { vars: ['s'] }, results: { bindings: [] } };
  let calls = 0;
  const fetchFn: SparqlFetchFn = (async () => {
    calls += 1;
    return jsonResponse(payload);
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const outcome = await adapter.executeQuery(
    { query: 'PREFIX : <https://e/> SELECT * WHERE { ?s ?p ?o }', pageSize: 10, from: 0 },
    { token: SENTINEL },
  );
  assert.equal(outcome.error, undefined);
  assert.equal(calls, 1);
});

test('probe hoists PREFIX preamble above the COUNT(*) wrapper', async () => {
  const seenBodies: string[] = [];
  const fetchFn: SparqlFetchFn = (async (_url: string, init?: RequestInit) => {
    seenBodies.push(String(init?.body ?? ''));
    return jsonResponse({
      head: { vars: ['count'] },
      results: { bindings: [{ count: { type: 'literal', value: '7' } }] },
    });
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const outcome = await adapter.probeCardinality(
    { queries: ['PREFIX ex: <http://ex.org/> SELECT * WHERE { ?s ?p ?o }'] },
    { token: SENTINEL },
  );
  assert.equal(outcome.items[0]?.status, 'ok');
  const dispatched = decodeURIComponent(seenBodies[0] ?? '');
  const prefixAt = dispatched.indexOf('PREFIX ex:');
  const whereAt = dispatched.search(/WHERE\s*\{/i);
  assert.ok(prefixAt >= 0 && whereAt > prefixAt, 'PREFIX preamble must lead the COUNT(*) wrapper');
});

test('probe leaves PREFIX-shaped text inside string literals untouched', async () => {
  const seenBodies: string[] = [];
  const fetchFn: SparqlFetchFn = (async (_url: string, init?: RequestInit) => {
    seenBodies.push(String(init?.body ?? ''));
    return jsonResponse({
      head: { vars: ['count'] },
      results: { bindings: [{ count: { type: 'literal', value: '3' } }] },
    });
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const query = 'SELECT * WHERE { ?s ?p "PREFIX ex: <http://ex.org/>" }';
  const outcome = await adapter.probeCardinality({ queries: [query] }, { token: SENTINEL });
  assert.equal(outcome.items[0]?.status, 'ok');
  const dispatched = decodeURIComponent(seenBodies[0] ?? '');
  assert.ok(dispatched.includes('"PREFIX ex: <http://ex.org/>"'), 'string literal must survive verbatim');
  assert.ok(!/^\s*PREFIX\b/i.test(dispatched), 'no hoisted preamble when PREFIX occurs only in a literal');
});

test('query classifies SELECT with hash-IRI PREFIX preamble as SELECT', async () => {
  const payload = { head: { vars: ['s'] }, results: { bindings: [] } };
  let calls = 0;
  const fetchFn: SparqlFetchFn = (async () => {
    calls += 1;
    return jsonResponse(payload);
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const cases = [
    // Hash inside <IRI> in PREFIX preamble must not split into a comment.
    'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> SELECT * WHERE { ?s ?p ?o }',
    // Real full-line and trailing # comments still stripped before classification.
    '# leading comment\nSELECT * WHERE { ?s ?p ?o }',
    'SELECT * WHERE { ?s ?p ?o } # trailing comment',
    // '#' inside quoted strings is data, not a comment.
    'SELECT * WHERE { ?s ?p "a#b" }',
    "SELECT * WHERE { ?s ?p 'a#b' }",
    // '#' inside <IRI> in the pattern body is data, not a comment.
    'SELECT * WHERE { <http://ex.org/s#frag> ?p ?o }',
  ];
  for (const query of cases) {
    const outcome = await adapter.executeQuery({ query, pageSize: 10, from: 0 }, { token: SENTINEL });
    assert.equal(outcome.error, undefined, `expected SELECT dispatch for: ${query}`);
  }
  assert.equal(calls, cases.length);
});

test('aborted signal surfaces operation_aborted without token leak', async () => {
  const fetchFn: SparqlFetchFn = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
    });
  }) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const controller = new AbortController();
  controller.abort();
  const outcome = await adapter.executeQuery({ query: 'SELECT * WHERE { ?s ?p ?o }', pageSize: 10, from: 0 }, { token: SENTINEL, signal: controller.signal });
  assert.equal(outcome.error?.code, 'operation_aborted');
  assert.ok(!outcome.error?.message.includes(SENTINEL));
});

test('query executes bounded SELECT results JSON as object shape, no cursor', async () => {
  const payload = { head: { vars: ['s'] }, results: { bindings: [{ s: { type: 'uri', value: 'http://ex.org/a' } }] } };
  const fetchFn: SparqlFetchFn = (async () => jsonResponse(payload)) as SparqlFetchFn;
  const adapter = createSparqlGraphAdapter({ endpoint: ENDPOINT, fetchFn });
  const outcome = await adapter.executeQuery(
    { query: 'SELECT * WHERE { ?s ?p ?o } LIMIT 10', pageSize: 10, from: 0 },
    { token: SENTINEL },
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.shape, 'object');
  assert.deepEqual(outcome.result, payload);
  assert.deepEqual(outcome.pagination, { hasMore: false });
});
