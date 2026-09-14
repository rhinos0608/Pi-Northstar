import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSparqlError, sparqlPost } from '../../src/sparql/sparql-transport.js';

const ENDPOINT = 'https://sparql.example.org/sparql';
const SENTINEL = 'SENTINEL_SPARQL_TOKEN_abc123xyz';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/sparql-results+json', ...headers },
  });
}

test('POSTs urlencoded query with SPARQL accept headers and bearer auth in header only', async () => {
  let seenUrl = '';
  let seenMethod: string | undefined;
  let seenBody = '';
  let seenHeaders = new Headers();
  const fetchFn: FetchFn = async (url, init) => {
    seenUrl = url;
    seenMethod = init?.method;
    seenBody = String(init?.body ?? '');
    seenHeaders = new Headers(init?.headers);
    return jsonResponse({ head: { vars: ['s'] }, results: { bindings: [] } });
  };
  const parsed = await sparqlPost<{ head: { vars: string[] } }>({
    endpoint: ENDPOINT,
    query: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
    token: SENTINEL,
    fetchFn,
  });
  assert.deepEqual(parsed.head.vars, ['s']);
  assert.equal(seenMethod, 'POST');
  assert.equal(seenUrl, ENDPOINT);
  assert.ok(!seenUrl.includes(SENTINEL), 'token must never appear in URL');
  assert.equal(seenHeaders.get('authorization'), `Bearer ${SENTINEL}`);
  assert.equal(seenHeaders.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(seenHeaders.get('accept'), 'application/sparql-results+json');
  assert.ok(seenBody.includes('query='), 'body must carry urlencoded query');
});

test('preserves endpoint query string such as default-graph-uri', async () => {
  let seenUrl = '';
  const fetchFn: FetchFn = async (url) => {
    seenUrl = url;
    return jsonResponse({ head: { vars: [] }, results: { bindings: [] } });
  };
  await sparqlPost({
    endpoint: 'https://sparql.example.org/sparql?default-graph-uri=https%3A%2F%2Fex.org%2Fg&repository=main',
    query: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
    fetchFn,
  });
  assert.ok(seenUrl.includes('default-graph-uri=https%3A%2F%2Fex.org%2Fg'), 'endpoint query string must survive');
  assert.ok(seenUrl.includes('repository=main'), 'repository param must survive');
});

test('rejects endpoint credentials, non-http scheme, and empty query', async () => {
  const neverFetch: FetchFn = async () => {
    throw new Error('fetch must not dispatch on invalid endpoint');
  };
  await assert.rejects(
    sparqlPost({ endpoint: 'https://user:pass@sparql.example.org/sparql', query: 'SELECT * WHERE { ?s ?p ?o }', fetchFn: neverFetch }),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'unsupported_option',
  );
  await assert.rejects(
    sparqlPost({ endpoint: 'ftp://sparql.example.org/sparql', query: 'SELECT * WHERE { ?s ?p ?o }', fetchFn: neverFetch }),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'unsupported_option',
  );
  await assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: '   ', fetchFn: neverFetch }),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'contract_invalid_response',
  );
});

test('allows operator loopback endpoint without token', async () => {
  let seenAuth: string | null = 'unset';
  const fetchFn: FetchFn = async (_url, init) => {
    seenAuth = new Headers(init?.headers).get('authorization');
    return jsonResponse({ head: { vars: [] }, results: { bindings: [] } });
  };
  await sparqlPost({ endpoint: 'http://127.0.0.1:8890/sparql', query: 'ASK { ?s ?p ?o }', fetchFn });
  assert.equal(seenAuth, null);
});

test('3xx redirect rejects, never follows, single dispatch', async () => {
  let calls = 0;
  const fetchFn: FetchFn = async () => {
    calls += 1;
    return new Response('', { status: 302, headers: { location: 'https://other.example.org/sparql' } });
  };
  await assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: 'SELECT * WHERE { ?s ?p ?o }', token: SENTINEL, fetchFn }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /never forwarded/);
      assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked in redirect error');
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('non-2xx error never contains sentinel token; 5xx retryable, 4xx not', async () => {
  const serverError: FetchFn = async () => jsonResponse({ error: 'boom' }, 503);
  await assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: 'SELECT * WHERE { ?s ?p ?o }', token: SENTINEL, fetchFn: serverError }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { retryable?: boolean }).retryable, true);
      assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked in 5xx error');
      return true;
    },
  );
  const clientError: FetchFn = async () => jsonResponse({ error: 'forbidden' }, 403);
  await assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: 'SELECT * WHERE { ?s ?p ?o }', token: SENTINEL, fetchFn: clientError }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { retryable?: boolean }).retryable, false);
      assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked in 4xx error');
      return true;
    },
  );
});

test('503 HTML proxy error classifies retryable independent of media type', async () => {
  const fetchFn: FetchFn = async () =>
    new Response('<html><body>Service Unavailable</body></html>', {
      status: 503,
      headers: { 'content-type': 'text/html' },
    });
  await assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: 'SELECT * WHERE { ?s ?p ?o }', token: SENTINEL, fetchFn }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, 'transport_invalid_response');
      assert.equal((err as { retryable?: boolean }).retryable, true);
      assert.equal((err as { status?: number }).status, 503);
      assert.ok(!err.message.includes(SENTINEL), 'sentinel token leaked in 503 HTML error');
      return true;
    },
  );
});

test('oversize body maps to non-retryable response_too_large', async () => {
  const fetchFn: FetchFn = async () =>
    new Response('x'.repeat(100), { status: 200, headers: { 'content-length': '100' } });
  await assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: 'SELECT * WHERE { ?s ?p ?o }', token: SENTINEL, maxBytes: 10, fetchFn }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, 'response_too_large');
      assert.equal((err as { retryable?: boolean }).retryable, false);
      return true;
    },
  );
});

test('invalid JSON rejects as transport error without token leak', async () => {
  const fetchFn: FetchFn = async () => new Response('not json{{{', { status: 200 });
  await assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: 'SELECT * WHERE { ?s ?p ?o }', token: SENTINEL, fetchFn }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, 'transport_invalid_response');
      assert.ok(!err.message.includes(SENTINEL));
      return true;
    },
  );
});

test('redaction strips token and slices to 500 chars', async () => {
  const out = redactSparqlError(`fail ${SENTINEL} ${'x'.repeat(600)}`, SENTINEL);
  assert.ok(!out.includes(SENTINEL));
  assert.ok(out.length <= 500);
});

test('endpoint query params never leak into error messages, still dispatch on wire', async () => {
  const querySecret = 'QUERY_SENTINEL_k7q2m9x4';
  const endpoint = `https://sparql.example.org/sparql?api_key=${querySecret}`;
  let seenUrl = '';
  const fetchFn: FetchFn = async (url) => {
    seenUrl = url;
    throw new Error('boom connection refused');
  };
  await assert.rejects(
    sparqlPost({ endpoint, query: 'SELECT * WHERE { ?s ?p ?o }', fetchFn }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(querySecret), 'endpoint query secret leaked in error');
      assert.ok(!err.message.includes('api_key'), 'endpoint query key leaked in error');
      assert.ok(err.message.includes('https://sparql.example.org/sparql'), 'error must still identify origin+path');
      return true;
    },
  );
  assert.ok(seenUrl.includes(`api_key=${querySecret}`), 'query string must still dispatch on the wire');
});

test('invalid endpoint echo strips query string', async () => {
  const querySecret = 'QUERY_SENTINEL_z8w3n6p1';
  const neverFetch: FetchFn = async () => {
    throw new Error('fetch must not dispatch on invalid endpoint');
  };
  await assert.rejects(
    sparqlPost({ endpoint: `not a url?api_key=${querySecret}`, query: 'SELECT * WHERE { ?s ?p ?o }', fetchFn: neverFetch }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(querySecret), 'query secret leaked in invalid-endpoint error');
      assert.ok(!err.message.includes('api_key'), 'query key leaked in invalid-endpoint error');
      return true;
    },
  );
});

test('caller abort signal surfaces retryable transport error', async () => {
  const fetchFn: FetchFn = async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
    });
  };
  const controller = new AbortController();
  const pending = assert.rejects(
    sparqlPost({ endpoint: ENDPOINT, query: 'SELECT * WHERE { ?s ?p ?o }', token: SENTINEL, signal: controller.signal, fetchFn }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { retryable?: boolean }).retryable, true);
      assert.ok(!err.message.includes(SENTINEL));
      return true;
    },
  );
  controller.abort();
  await pending;
});
