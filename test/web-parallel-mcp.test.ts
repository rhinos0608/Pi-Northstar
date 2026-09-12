import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARALLEL_MCP_ENDPOINT, parallelMcpSearchAdapter } from '../src/web-parallel-mcp.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'parallel-mcp-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 8,
    env: { PARALLEL_API_KEY: SECRET },
    nativeAi: { summaries: false, answers: false },
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcResult(result: unknown): unknown {
  return { jsonrpc: '2.0', id: 1, result };
}

test('parallel-mcp always configured, even anonymous', () => {
  assert.equal(parallelMcpSearchAdapter.id, 'parallel-mcp');
  assert.equal(parallelMcpSearchAdapter.configured({}), true);
  assert.equal(parallelMcpSearchAdapter.configured({ PARALLEL_API_KEY: 'x' }), true);
});

test('parallel-mcp exact endpoint, JSON-RPC body, bearer header; anonymous omits auth', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse(rpcResult({ results: [] })));
  try {
    await parallelMcpSearchAdapter.search(input());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, PARALLEL_MCP_ENDPOINT);
    assert.equal(new URL(calls[0]!.url).origin, 'https://search.parallel.ai');
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(headers['Content-Type'], 'application/json');
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.method, 'tools/call');
    assert.deepEqual((body.params as Record<string, unknown>).name, 'web_search');
    assert.deepEqual(
      ((body.params as Record<string, unknown>).arguments as Record<string, unknown>).search_queries,
      ['transformer interpretability'],
    );
  } finally {
    restore();
  }
  const m2 = mockFetch(async () => jsonResponse(rpcResult({ results: [] })));
  try {
    await parallelMcpSearchAdapter.search(input({ env: {} }));
    const headers = m2.calls[0]!.init?.headers as Record<string, string>;
    assert.ok(!('Authorization' in headers), 'anonymous call must not send auth');
    assert.equal(m2.calls.length, 1);
  } finally {
    m2.restore();
  }
});

test('parallel-mcp encoding 1: structuredContent array', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse(
      rpcResult({
        structuredContent: [{ title: 'S', url: 'https://example.com/s', excerpts: ['a', 'b'] }],
      }),
    ),
  );
  try {
    const out = await parallelMcpSearchAdapter.search(input());
    assert.equal(out.backend, 'parallel-mcp');
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/s');
    assert.equal(out.hits[0]!.snippet, 'a b');
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('parallel-mcp encoding 2: JSON text block with results envelope', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse(
      rpcResult({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ results: [{ title: 'J', url: 'https://example.com/j', excerpts: ['txt'] }] }),
          },
        ],
      }),
    ),
  );
  try {
    const out = await parallelMcpSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/j');
    assert.equal(out.hits[0]!.snippet, 'txt');
  } finally {
    restore();
  }
});

test('parallel-mcp encoding 3: labeled Title/URL/Text fallback', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse(
      rpcResult({
        content: [
          {
            type: 'text',
            text: 'Title: First Hit\nURL: https://example.com/1\nText: snippet one\n\nTitle: Second\nURL: https://example.com/2\nText: snippet two',
          },
        ],
      }),
    ),
  );
  try {
    const out = await parallelMcpSearchAdapter.search(input());
    assert.equal(out.hits.length, 2);
    assert.equal(out.hits[0]!.title, 'First Hit');
    assert.equal(out.hits[0]!.url, 'https://example.com/1');
    assert.equal(out.hits[0]!.snippet, 'snippet one');
    assert.equal(out.hits[1]!.url, 'https://example.com/2');
  } finally {
    restore();
  }
});

test('parallel-mcp local slice to limit; malformed rows dropped; invalid envelope rejects', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    title: `T${i}`,
    url: `https://example.com/${i}`,
    excerpts: [`e${i}`],
  }));
  const { restore } = mockFetch(async () => jsonResponse(rpcResult({ results: rows })));
  try {
    const out = await parallelMcpSearchAdapter.search(input({ limit: 3 }));
    assert.equal(out.hits.length, 3);
  } finally {
    restore();
  }
  const m2 = mockFetch(async () =>
    jsonResponse(
      rpcResult({ results: [{ title: 'G', url: 'https://example.com/g', excerpts: ['ok'] }, 'bad', 42] }),
    ),
  );
  try {
    const out = await parallelMcpSearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
  } finally {
    m2.restore();
  }
  for (const bad of [
    jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'nope' } }),
    jsonResponse(rpcResult({ content: [{ type: 'text', text: 'not json at all {{{' }] })),
    jsonResponse(rpcResult({})),
    jsonResponse({ nope: true }),
  ]) {
    const m = mockFetch(async () => bad);
    try {
      await assert.rejects(parallelMcpSearchAdapter.search(input()), /invalid response/);
    } finally {
      m.restore();
    }
  }
});

test('parallel-mcp no retry, redacted error, redirect rejected, oversize rejected', async () => {
  const key = 'parallel-mcp-redact-123';
  const m1 = mockFetch(async () => new Response('boom', { status: 429 }));
  try {
    await assert.rejects(
      parallelMcpSearchAdapter.search(input({ env: { PARALLEL_API_KEY: key } })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key), 'key leaked into error');
        return true;
      },
    );
    assert.equal(m1.calls.length, 1);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }));
  try {
    await assert.rejects(parallelMcpSearchAdapter.search(input()), /Redirect rejected/);
  } finally {
    m2.restore();
  }
  const big = 'x'.repeat(1_000_005);
  const m3 = mockFetch(async () => new Response(JSON.stringify({ pad: big }), { status: 200 }));
  try {
    await assert.rejects(parallelMcpSearchAdapter.search(input()), /size limit|too large/i);
  } finally {
    m3.restore();
  }
});

test('parallel-mcp passes composed policy signal through', async () => {
  let seenSignal: AbortSignal | undefined;
  const { calls, restore } = mockFetch((_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonResponse(rpcResult({ results: [] }));
  });
  try {
    const controller = new AbortController();
    const out = await parallelMcpSearchAdapter.search(input({ signal: controller.signal }));
    assert.equal(calls.length, 1);
    assert.equal(out.backend, 'parallel-mcp');
    assert.equal(seenSignal, controller.signal);
  } finally {
    restore();
  }
});

test('parallel-mcp abort propagates', async () => {
  const { restore } = mockFetch(async () => {
    throw new DOMException('This operation was aborted', 'AbortError');
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(parallelMcpSearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});
